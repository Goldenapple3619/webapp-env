#!/usr/bin/env python3
"""
The sandbox runner: executes real tools (gcc, python...) for the gateway, one isolated job at a time per request.

    GET  /v1/health  (no auth)   -> {"ok": true}
    GET  /v1/tools               -> {"sandbox": "bwrap+seccomp", "tools": [{name, description, version, limits}]}
    POST /v1/run                 -> {status, stdout, stderr, timed_out, cancelled, truncated, signal, duration_ms, wall_limit}
    POST /v1/cancel {"job": id}  -> {"cancelled": bool}

Deployed on an internal network that only the gateway can reach, authenticated with a shared bearer token. It holds no
secrets (no JWT key, no database password) and has no network egress; jobs get even less (see sandbox.py). If the sandbox
cannot be established - or if the start-up self-test shows it leaks - the process refuses to serve: it fails CLOSED.
Standard library only, so the image has nothing to patch except the toolchains themselves.
"""
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sandbox import SANDBOX_ROOT, Sandbox, base_env  # noqa: E402

MAX_BODY = 2 * 1024 * 1024
JOB_ID = re.compile(r"^[0-9a-f]{8,32}$")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
HARD_CAPS = {"wall_s": 300, "cpu_s": 300, "mem_mb": 8192, "fsize_mb": 1024, "nofile": 4096, "output_kb": 4096, "stdin_kb": 4096}


class BadRequest(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def env_int(name, default, low, high):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        sys.exit(f"{name} must be an integer")
    if not low <= value <= high:
        sys.exit(f"{name} must be between {low} and {high}")
    return value


class Settings:
    def __init__(self, **overrides):
        self.token = os.environ.get("RUNNER_TOKEN", "")
        self.host = os.environ.get("RUNNER_HOST", "0.0.0.0")
        self.port = env_int("RUNNER_PORT", 8002, 1, 65535)
        self.users_root = os.environ.get("USERS_ROOT", "/mnt/system/users")
        self.max_jobs = env_int("RUNNER_MAX_JOBS", max(2, os.cpu_count() or 2), 1, 256)
        self.per_user = env_int("RUNNER_PER_USER", 2, 1, 32)
        self.queue_wait = env_int("RUNNER_QUEUE_WAIT", 3, 0, 60)
        self.nproc = env_int("RUNNER_NPROC", 512, 16, 100000)
        self.tools_file = os.environ.get("RUNNER_TOOLS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools.json"))
        self.seccomp = os.environ.get("RUNNER_SECCOMP", "/opt/runner/seccomp.bpf")
        self.etc_dir = os.environ.get("RUNNER_ETC", "/run/runner/etc")
        self.mount_proc = os.environ.get("RUNNER_MOUNT_PROC", "1") != "0"   # see README: Docker's masked /proc can forbid it
        for key, value in overrides.items():
            setattr(self, key, value)


def clamp_path(path) -> str:
    """'/a/../../b' -> '/b'. The same rule as the gateway: `..` can never climb above the user's root."""
    if not isinstance(path, str) or not path.startswith("/") or len(path) > 1024 or "\x00" in path:
        raise BadRequest("a path must be absolute")
    parts = []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return "/" + "/".join(parts)


class Job:
    def __init__(self, job_id, user):
        self.id, self.user, self.proc, self.cancelled = job_id, user, None, False


class Runner:
    def __init__(self, settings: Settings):
        self.s = settings
        self.sandbox = Sandbox(seccomp_bpf=settings.seccomp, etc_dir=settings.etc_dir, nproc=settings.nproc, mount_proc=settings.mount_proc)
        self.users_root = os.path.realpath(settings.users_root)
        self.slots = threading.BoundedSemaphore(settings.max_jobs)
        self.lock = threading.Lock()
        self.per_user = defaultdict(int)
        self.jobs: dict[str, Job] = {}
        with open(settings.tools_file) as fp:
            spec = json.load(fp)
        self.defaults = spec.get("defaults", {})
        self.tools = {}
        for tool in spec.get("tools", []):
            if os.path.isfile(tool["bin"]) and os.access(tool["bin"], os.X_OK):
                self.tools[tool["name"]] = {**tool, "limits": self._limits(tool.get("limits", {})), "version": self._version(tool)}

    def _limits(self, overrides: dict) -> dict:
        merged = {**self.defaults, **overrides}
        return {k: min(int(merged[k]), HARD_CAPS[k]) for k in HARD_CAPS if k in merged}

    @staticmethod
    def _version(tool) -> str:
        try:  # run on the host side, outside any job: these are our own trusted binaries
            out = subprocess.run([tool["bin"], "--version"], capture_output=True, timeout=5, text=True, env={"PATH": "/usr/bin:/bin"}).stdout
            return out.strip().splitlines()[0][:80] if out.strip() else ""
        except Exception:
            return ""

    def catalog(self) -> dict:
        shown = [{"name": n, "description": t.get("description", ""), "version": t["version"],
                  "limits": {k: t["limits"][k] for k in ("wall_s", "mem_mb", "output_kb") if k in t["limits"]}}
                 for n, t in sorted(self.tools.items())]
        return {"sandbox": "bwrap+seccomp" if self.s.seccomp else "bwrap", "tools": shown}

    def _user_root(self, user) -> str:
        if isinstance(user, bool) or not isinstance(user, int) or user <= 0:
            raise BadRequest("invalid user")
        root = os.path.realpath(os.path.join(self.users_root, str(user), "root"))
        if not root.startswith(self.users_root + os.sep) or not os.path.isdir(root):
            raise BadRequest("no such user folder")
        return root

    def _validate(self, req: dict):
        if req.get("v") != 1:
            raise BadRequest("unsupported protocol version")
        job_id = req.get("job")
        if not isinstance(job_id, str) or not JOB_ID.match(job_id):
            raise BadRequest("invalid job id")
        root = self._user_root(req.get("user"))
        cwd = clamp_path(req.get("cwd", "/"))
        if not os.path.isdir(os.path.realpath(root + cwd)) or not os.path.realpath(root + cwd).startswith(root):
            raise BadRequest("the working folder does not exist")
        argv = req.get("argv", [])
        if not isinstance(argv, list) or len(argv) > 256 or sum(len(a) for a in argv if isinstance(a, str)) > 128 * 1024 \
                or not all(isinstance(a, str) and "\x00" not in a and len(a) <= 8192 for a in argv):
            raise BadRequest("invalid arguments")
        env = req.get("env", {})
        if not isinstance(env, dict) or len(env) > 32 or not all(
                isinstance(k, str) and ENV_NAME.match(k) and isinstance(v, str) and len(v) <= 1024 and "\x00" not in v for k, v in env.items()):
            raise BadRequest("invalid environment")
        kind = req.get("kind")
        if kind == "tool":
            tool = self.tools.get(req.get("tool"))
            if tool is None:
                raise BadRequest("unknown tool")
            program, tool_env, limits = [tool["bin"]], tool.get("env", {}), tool["limits"]
        elif kind == "file":
            path = clamp_path(req.get("path"))
            host = os.path.realpath(root + path)
            if not host.startswith(root + os.sep) or not os.path.isfile(host) or not os.access(host, os.X_OK):
                raise BadRequest("not an executable file in your folder")
            program, tool_env, limits = [SANDBOX_ROOT + path], {}, self._limits({})
        else:
            raise BadRequest("kind must be tool or file")
        stdin = req.get("stdin")
        if stdin is not None:
            if not isinstance(stdin, str) or len(stdin.encode("utf-8", "replace")) > limits["stdin_kb"] * 1024:
                raise BadRequest("stdin too large")
        return job_id, root, cwd, program + argv, base_env(tool_env, env), limits, stdin, bool(req.get("merge"))

    def run(self, req: dict) -> dict:
        job_id, root, cwd, argv, env, limits, stdin, merge = self._validate(req)
        user = req["user"]
        with self.lock:
            if job_id in self.jobs:
                raise BadRequest("duplicate job id", 409)
            if self.per_user[user] >= self.s.per_user:
                raise BadRequest(f"at most {self.s.per_user} programs at a time per user", 429)
            self.per_user[user] += 1
            job = self.jobs[job_id] = Job(job_id, user)
        got_slot = False
        try:
            got_slot = self.slots.acquire(timeout=self.s.queue_wait)
            if not got_slot:
                raise BadRequest("the sandbox is busy, try again in a moment", 429)
            return self._execute(job, root, cwd, argv, env, limits, stdin, merge)
        finally:
            if got_slot:
                self.slots.release()
            with self.lock:
                self.per_user[user] -= 1
                self.jobs.pop(job_id, None)

    def _execute(self, job, root, cwd, argv, env, limits, stdin, merge) -> dict:
        cmd = self.sandbox.command(root=root, cwd=cwd, argv=argv, env=env, limits=limits)
        started, fd = time.monotonic(), None
        if self.s.seccomp:
            fd = os.open(self.s.seccomp, os.O_RDONLY)
            cmd = [str(fd) if part == "{SECCOMP_FD}" else part for part in cmd]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT if merge else subprocess.PIPE, env={}, close_fds=True,
                                    pass_fds=(fd,) if fd is not None else (), start_new_session=True)
        except OSError as exc:
            raise BadRequest(f"could not start the sandbox: {exc.strerror}", 503)
        finally:
            if fd is not None:
                os.close(fd)
        job.proc = proc
        cap = limits["output_kb"] * 1024
        sinks = {"out": bytearray(), "err": bytearray()}
        flags = {"truncated": False}

        def pump(stream, key):
            sink = sinks[key]
            while True:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    return
                room = cap - len(sink)
                if room > 0:
                    sink += chunk[:room]
                if len(chunk) > room and not flags["truncated"]:
                    flags["truncated"] = True
                    self._kill(proc)                    # a program that floods its output is not allowed to run on

        def feed():
            try:
                if stdin:
                    proc.stdin.write(stdin.encode("utf-8", "replace"))
            except OSError:
                pass
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        threads = [threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True), threading.Thread(target=feed, daemon=True)]
        if not merge:
            threads.append(threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True))
        for t in threads:
            t.start()
        timed_out = False
        try:
            proc.wait(timeout=limits["wall_s"])
        except subprocess.TimeoutExpired:
            timed_out = True
            self._kill(proc)
            proc.wait()
        for t in threads:
            t.join(timeout=3)
        for stream in (proc.stdin, proc.stdout, proc.stderr):   # one descriptor per pipe per job: never leave them to the GC
            try:
                if stream:
                    stream.close()
            except OSError:
                pass
        status = proc.returncode
        sig = None
        if status is not None and status < 0:
            status, sig = 128 - status, signal.Signals(-proc.returncode).name
        elif status is not None and 129 <= status <= 159:
            try:
                sig = signal.Signals(status - 128).name
            except ValueError:
                pass
        if job.cancelled:
            sig = None
        return {"status": status, "stdout": sinks["out"].decode("utf-8", "replace"), "stderr": sinks["err"].decode("utf-8", "replace"),
                "timed_out": timed_out, "cancelled": job.cancelled, "truncated": flags["truncated"], "signal": sig,
                "duration_ms": int((time.monotonic() - started) * 1000), "wall_limit": limits["wall_s"]}

    @staticmethod
    def _kill(proc) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)         # bwrap and, through --die-with-parent, the whole pid namespace
        except (ProcessLookupError, PermissionError):
            pass

    def cancel(self, job_id) -> bool:
        with self.lock:
            job = self.jobs.get(job_id) if isinstance(job_id, str) else None
        if job is None or job.proc is None:
            return False
        job.cancelled = True
        self._kill(job.proc)
        return True

    def stop_all(self) -> None:
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancelled = True
            if job.proc:
                self._kill(job.proc)

    def selftest(self) -> None:
        """Runs a probe INSIDE the real sandbox and refuses to serve if it can do what it must not."""
        import tempfile
        probe = ("import ctypes,json,os\n"
                 "libc=ctypes.CDLL(None,use_errno=True)\n"
                 "print(json.dumps({'userns':libc.unshare(0x10000000),'root':sorted(os.listdir('/')),"
                 "'net':sorted(os.listdir('/sys/class/net')) if os.path.isdir('/sys/class/net') else [],"
                 "'env':sorted(os.environ),'host_users':os.path.exists('/mnt/system'),'uid':os.getuid()}))\n")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "1", "root"))
            saved, self.users_root = self.users_root, os.path.realpath(tmp)
            try:
                python = self.tools.get("python3") or next(iter(self.tools.values()), None)
                if python is None:
                    raise RuntimeError("no tool available to self-test with")
                argv = [python["bin"], "-c", probe]
                result = self._execute(Job("0" * 8, 1), os.path.join(self.users_root, "1", "root"), "/", argv,
                                       base_env({}, {}), self._limits({"wall_s": 20}), None, False)
            finally:
                self.users_root = saved
        if result["status"] != 0:
            raise RuntimeError(f"the sandbox could not start a job: {result['stderr'].strip()[:300] or result['status']}")
        facts = json.loads(result["stdout"])
        problems = []
        if facts["userns"] != -1:
            problems.append("a job can create a nested user namespace (seccomp filter not applied)")
        if facts["host_users"]:
            problems.append("a job can see /mnt/system")
        if set(facts["root"]) - {"usr", "bin", "sbin", "lib", "lib64", "lib32", "libx32", "etc", "proc", "dev", "tmp", "var", "work", "sys"}:
            problems.append(f"unexpected paths visible to a job: {facts['root']}")
        if set(facts["net"]) - {"lo"}:
            problems.append(f"a job can see network interfaces: {facts['net']}")
        leaked = set(facts["env"]) - {"PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "TERM", "PWD", "PYTHONDONTWRITEBYTECODE",
                                       "PYTHONNOUSERSITE", "PYTHONUNBUFFERED", "LC_CTYPE"}
        if leaked:
            problems.append(f"environment variables leak into jobs: {sorted(leaked)}")
        if problems:
            raise RuntimeError("sandbox self-test FAILED: " + "; ".join(problems))


def make_handler(runner: Runner):
    token = runner.s.token.encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "runner"
        sys_version = ""
        timeout = 30

        def log_message(self, fmt, *args):  # no access log: it would be noise; jobs are logged once, below
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            return header.startswith("Bearer ") and hmac.compare_digest(header[7:].encode(), token)

        def _body(self) -> dict:
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise BadRequest("Content-Length required", 411)
            if not 0 <= length <= MAX_BODY:
                raise BadRequest("request too large", 413)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                raise BadRequest("invalid JSON")
            if not isinstance(data, dict):
                raise BadRequest("expected an object")
            return data

        def do_GET(self):
            if self.path == "/v1/health":
                return self._send(200, {"ok": True})
            if not self._authorized():
                return self._send(401, {"message": "unauthorized"})
            if self.path == "/v1/tools":
                return self._send(200, runner.catalog())
            self._send(404, {"message": "not found"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"message": "unauthorized"})
            try:
                body = self._body()
                if self.path == "/v1/run":
                    t0 = time.monotonic()
                    result = runner.run(body)
                    print(f"job user={body.get('user')} kind={body.get('kind')} tool={body.get('tool') or '-'} "
                          f"status={result['status']} ms={int((time.monotonic() - t0) * 1000)}"
                          f"{' TIMEOUT' if result['timed_out'] else ''}{' CANCELLED' if result['cancelled'] else ''}", flush=True)
                    return self._send(200, result)
                if self.path == "/v1/cancel":
                    return self._send(200, {"cancelled": runner.cancel(body.get("job"))})
                self._send(404, {"message": "not found"})
            except BadRequest as exc:
                self._send(exc.status, {"message": str(exc)})
            except Exception as exc:
                print(f"internal error: {exc!r}", flush=True)
                self._send(500, {"message": "internal error"})

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def main() -> None:
    settings = Settings()
    if len(settings.token) < 32:
        sys.exit("RUNNER_TOKEN must be set (>= 32 characters)")
    runner = Runner(settings)
    if not runner.tools:
        sys.exit("no tool from tools.json is installed in this image")
    runner.sandbox.prepare_etc()
    if settings.seccomp and not os.path.isfile(settings.seccomp):
        sys.exit(f"seccomp filter {settings.seccomp} is missing (build it with seccomp_gen.c) - refusing to run jobs without it")
    try:
        runner.selftest()
    except Exception as exc:
        sys.exit(f"{exc}\nrefusing to serve: the sandbox must work before any job is accepted (is the container allowed to create user namespaces? see README)")
    server = Server((settings.host, settings.port), make_handler(runner))
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(f"runner ready on {settings.host}:{settings.port}: {', '.join(sorted(runner.tools))} "
          f"(max {settings.max_jobs} jobs, {settings.per_user} per user)", flush=True)
    try:
        server.serve_forever()
    finally:
        runner.stop_all()


if __name__ == "__main__":
    main()
