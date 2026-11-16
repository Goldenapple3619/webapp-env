"""
How one job is isolated. Everything about confinement lives in this file so it can be read (and audited) in one sitting.

Layers, outermost first:
  1. the container the runner lives in: no network, no secrets, read-only root, dropped capabilities, cgroup limits;
  2. bubblewrap, per job: new user/pid/net/ipc/uts/cgroup namespaces, an empty tmpfs root with ONLY
        /usr (read-only, holds the toolchains), a minimal /etc, /proc of the new pid namespace, a minimal /dev,
        a private /tmp, and the one user's files at /work;
     no other user's files, no gateway files, no host paths exist inside it, and symlinks cannot lead out of /work because
     the rest of the host is simply not in the mount namespace;
  3. a seccomp filter (see seccomp_gen.c) removing namespaces, mount, ptrace, bpf, io_uring... from the job;
  4. prlimit: CPU time, address space, file size, open files, process count, no core dumps;
  5. the runner's own watchdog: wall clock timeout, output cap, cancellation. The whole pid namespace dies with its init.
The environment is rebuilt from scratch: nothing of the runner's own environment reaches a job.
"""
import os
import shutil

SANDBOX_ROOT = "/work"
DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"
MERGED_USR = ("bin", "sbin", "lib", "lib64", "lib32", "libx32")


class Sandbox:
    def __init__(self, *, bwrap="bwrap", prlimit="prlimit", seccomp_bpf=None, etc_dir="/run/runner/etc", nproc=512, mount_proc=True):
        self.bwrap = shutil.which(bwrap) or bwrap
        self.prlimit = shutil.which(prlimit) or prlimit
        self.seccomp_bpf = seccomp_bpf
        self.etc_dir = etc_dir
        self.nproc = nproc
        self.mount_proc = mount_proc

    def prepare_etc(self) -> None:
        """A tiny, static /etc for jobs (so getpwuid() and friends work); written once at startup."""
        os.makedirs(self.etc_dir, exist_ok=True)
        uid, gid = os.getuid(), os.getgid()
        files = {"passwd": f"user:x:{uid}:{gid}:user:{SANDBOX_ROOT}:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
                 "group": f"user:x:{gid}:\nnogroup:x:65534:\n",
                 "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files\n",
                 "hosts": "127.0.0.1 localhost\n"}
        for name, text in files.items():
            with open(os.path.join(self.etc_dir, name), "w") as fp:
                fp.write(text)

    def command(self, *, root: str, cwd: str, argv: list, env: dict, limits: dict) -> list:
        """The full command line (prlimit + bwrap + job). `root` is the host path of the user's files, `cwd` the user-visible
        working directory ('/documents'); nothing here is built by string concatenation of untrusted text into a shell."""
        cmd = [self.prlimit, f"--cpu={int(limits['cpu_s'])}", f"--as={int(limits['mem_mb']) * 1024 * 1024}",
               f"--fsize={int(limits['fsize_mb']) * 1024 * 1024}", f"--nofile={int(limits['nofile'])}",
               f"--nproc={self.nproc}", "--core=0", "--",
               self.bwrap,
               "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-cgroup-try",
               "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--hostname", "sandbox",
               "--ro-bind", "/usr", "/usr"]
        for name in MERGED_USR:                      # Debian layout: /bin -> usr/bin ...
            if os.path.islink("/" + name) or os.path.isdir("/usr/" + name):
                cmd += ["--symlink", "usr/" + name, "/" + name]
        for path in ("/etc/alternatives", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d"):
            cmd += ["--ro-bind-try", path, path]
        for name in ("passwd", "group", "nsswitch.conf", "hosts"):
            cmd += ["--ro-bind", os.path.join(self.etc_dir, name), "/etc/" + name]
        cmd += (["--proc", "/proc"] if self.mount_proc else ["--dir", "/proc"])
        cmd += ["--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/var", "--tmpfs", "/var/tmp",
                "--bind", root, SANDBOX_ROOT, "--chdir", SANDBOX_ROOT + (cwd if cwd != "/" else "")]
        for key, value in env.items():
            cmd += ["--setenv", key, value]
        if self.seccomp_bpf:
            cmd += ["--seccomp", "{SECCOMP_FD}"]       # replaced by the runner with the real descriptor number
        return cmd + ["--"] + argv


def base_env(extra_tool_env: dict, user_env: dict) -> dict:
    """User-supplied variables first, then the fixed ones win: a job can never redefine PATH, HOME, TMPDIR..."""
    env = dict(user_env)
    env.update(extra_tool_env)
    env.update({"PATH": DEFAULT_PATH, "HOME": SANDBOX_ROOT, "TMPDIR": "/tmp", "LANG": "C.UTF-8", "USER": "user",
                "LOGNAME": "user", "TERM": "dumb", "PWD": SANDBOX_ROOT})
    return env
