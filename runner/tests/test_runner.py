"""
Runs REAL jobs through the real sandbox (bubblewrap + seccomp). Needs bwrap and a compiled seccomp filter:
    gcc -O2 -o /tmp/seccomp_gen seccomp_gen.c -lseccomp && /tmp/seccomp_gen /tmp/seccomp.bpf
    python3 -m unittest tests.test_runner          (SECCOMP_BPF=/path/to/filter.bpf to point elsewhere)
Skipped with a clear message when the machine cannot create user namespaces.
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import runner as runner_module  # noqa: E402
from runner import Runner, Server, Settings, make_handler  # noqa: E402

TOKEN = "t" * 40
BPF = os.environ.get("SECCOMP_BPF", "/tmp/seccomp.bpf")


def tools_file(directory):
    py = shutil.which("python3")
    spec = {"defaults": {"wall_s": 10, "cpu_s": 8, "mem_mb": 1024, "fsize_mb": 16, "nofile": 256, "output_kb": 64, "stdin_kb": 64},
            "tools": [{"name": "gcc", "bin": shutil.which("gcc"), "description": "C", "limits": {"wall_s": 30, "cpu_s": 25, "mem_mb": 1536}},
                      {"name": "python3", "bin": py, "description": "py", "env": {"PYTHONDONTWRITEBYTECODE": "1"}, "limits": {"mem_mb": 700}},
                      {"name": "bash", "bin": shutil.which("bash"), "description": "bash"}]}
    path = os.path.join(directory, "tools.json")
    json.dump(spec, open(path, "w"))
    return path


def usable():
    if not shutil.which("bwrap") or not os.path.isfile(BPF):
        return "bwrap or the compiled seccomp filter (SECCOMP_BPF) is missing"
    return None


@unittest.skipIf(usable(), usable() or "")
class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        os.chmod(cls.tmp, 0o755)
        cls.users = os.path.join(cls.tmp, "users")
        for uid in (1, 2):
            os.makedirs(os.path.join(cls.users, str(uid), "root", "documents"))
        open(os.path.join(cls.users, "2", "root", "secret.txt"), "w").write("user two's secret")
        settings = Settings(token=TOKEN, users_root=cls.users, tools_file=tools_file(cls.tmp), seccomp=BPF,
                            etc_dir=os.path.join(cls.tmp, "etc"), max_jobs=4, per_user=2, queue_wait=1, port=0, host="127.0.0.1")
        os.environ["RUNNER_SECRET_LIKE_JWT"] = "must-never-reach-a-job"
        cls.runner = Runner(settings)
        cls.runner.sandbox.prepare_etc()
        cls.runner.selftest()
        cls.server = Server(("127.0.0.1", 0), make_handler(cls.runner))
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.root1 = os.path.join(cls.users, "1", "root")
        subprocess_chmod(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.runner.stop_all()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, token=TOKEN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        res = conn.getresponse()
        out = json.loads(res.read() or b"{}")
        conn.close()
        return res.status, out

    def run_job(self, tool="python3", argv=(), user=1, cwd="/", stdin=None, **extra):
        body = {"v": 1, "job": uuid.uuid4().hex[:16], "user": user, "kind": "tool", "tool": tool, "cwd": cwd, "argv": list(argv),
                "stdin": stdin, "env": {}, **extra}
        return self.call("POST", "/v1/run", body)

    def py(self, code, **kw):
        status, out = self.run_job("python3", ["-c", code], **kw)
        self.assertEqual(status, 200, out)
        return out

    def test_catalog_lists_only_installed_tools_with_limits(self):
        status, out = self.call("GET", "/v1/tools")
        self.assertEqual(status, 200)
        names = {t["name"] for t in out["tools"]}
        self.assertEqual(names, {"gcc", "python3", "bash"})
        gcc = next(t for t in out["tools"] if t["name"] == "gcc")
        self.assertIn("gcc", gcc["version"].lower())
        self.assertEqual(gcc["limits"]["wall_s"], 30)

    def test_compile_then_run_a_c_program(self):
        open(os.path.join(self.root1, "documents", "hello.c"), "w").write('#include <stdio.h>\nint main(int c,char**v){printf("hi %s\\n", c>1?v[1]:"?");return 3;}\n')
        out = self.run_job("gcc", ["hello.c", "-o", "hello"], cwd="/documents")[1]
        self.assertEqual((out["status"], out["stderr"]), (0, ""), out)
        self.assertTrue(os.access(os.path.join(self.root1, "documents", "hello"), os.X_OK), "the binary is in the user's real folder")
        status, run = self.call("POST", "/v1/run", {"v": 1, "job": "a" * 12, "user": 1, "kind": "file", "path": "/documents/hello", "cwd": "/documents", "argv": ["there"]})
        self.assertEqual((status, run["stdout"], run["status"]), (200, "hi there\n", 3))

    def test_compiler_errors_come_back_with_sandbox_paths(self):
        open(os.path.join(self.root1, "bad.c"), "w").write("int main( {\n")
        out = self.run_job("gcc", ["bad.c"])[1]
        self.assertNotEqual(out["status"], 0)
        self.assertIn("bad.c", out["stderr"])

    def test_stdin_and_merge(self):
        out = self.py("import sys;print(sys.stdin.read().upper())", stdin="abc")
        self.assertEqual(out["stdout"], "ABC\n")
        out = self.py("import sys;print('1');sys.stdout.flush();print('2',file=sys.stderr);sys.stderr.flush();print('3')", merge=True)
        self.assertEqual((out["stdout"], out["stderr"]), ("1\n2\n3\n", ""), "merged: one ordered stream")
        out = self.py("import sys;print('o');print('e',file=sys.stderr)")
        self.assertEqual((out["stdout"], out["stderr"]), ("o\n", "e\n"))

    def test_a_job_sees_only_its_own_files_at_work(self):
        out = self.py("import os,json;print(json.dumps([sorted(os.listdir('/')), sorted(os.listdir('/work')), os.getcwd()]))", cwd="/documents")
        root, work, cwd = json.loads(out["stdout"])
        self.assertEqual(cwd, "/work/documents")
        self.assertIn("documents", work)
        self.assertNotIn("secret.txt", work)
        for forbidden in ("mnt", "home", "root", "run", "opt", "srv", "media"):
            self.assertNotIn(forbidden, root)

    def test_another_users_files_do_not_exist_for_a_job(self):
        code = ("import os\nfor p in ['/mnt/system/users/2/root/secret.txt','/work/../2/root/secret.txt','/work/../../2/root/secret.txt','/../2/root/secret.txt']:\n"
                "    print(p, os.path.exists(p))\nprint(sorted(os.listdir('/work/..')))")
        out = self.py(code)["stdout"]
        self.assertNotIn("True", out, "none of the paths exist")
        self.assertNotIn("'2'", out, "user 2's folder is not even listed next to /work")

    def test_symlinks_cannot_lead_out(self):
        os.symlink("/etc/passwd", os.path.join(self.root1, "to_passwd"))
        os.symlink("../../2/root/secret.txt", os.path.join(self.root1, "to_other"))
        os.symlink(f"{self.users}/2/root/secret.txt", os.path.join(self.root1, "to_other_abs"))
        out = self.py("import os\nfor n in ['to_passwd','to_other','to_other_abs']:\n    try: print(n, open(n).read()[:60])\n    except OSError as e: print(n, 'ERR', e.errno)")["stdout"]
        self.assertNotIn("secret", out)
        self.assertNotIn("root:x:0", out, "the host's /etc/passwd is not reachable")
        self.assertIn("to_other ERR", out)
        self.assertIn("to_other_abs ERR", out)

    def test_runner_secrets_never_reach_a_job(self):
        out = self.py("import os,json;print(json.dumps(sorted(os.environ)))")
        self.assertNotIn("RUNNER_SECRET_LIKE_JWT", out["stdout"])
        self.assertNotIn("RUNNER_TOKEN", out["stdout"])
        out = self.run_job("python3", ["-c", "import os;print(os.environ.get('PATH'),os.environ.get('HOME'),os.environ.get('X'))"], env={"PATH": "/evil", "HOME": "/evil", "X": "1"})[1]
        self.assertEqual(out["stdout"], "/usr/local/bin:/usr/bin:/bin /work 1\n", "user variables pass, but can never redefine PATH/HOME")

    def test_no_network(self):
        out = self.py("import socket\ntry:\n    socket.create_connection(('1.1.1.1',80),timeout=2)\n    print('CONNECTED')\nexcept OSError as e:\n    print('blocked')\nprint(open('/proc/net/dev').read().count(':'))")["stdout"]
        self.assertTrue(out.startswith("blocked"), out)
        self.assertEqual(out.split("\n")[1], "1", "only loopback exists")

    def test_nested_namespaces_and_dangerous_syscalls_are_denied(self):
        code = ("import ctypes,os\nl=ctypes.CDLL(None,use_errno=True)\n"
                "print('userns',l.unshare(0x10000000),'netns',l.unshare(0x40000000),'mount',l.mount(b'x',b'/tmp',b'tmpfs',0,None),'ptrace',l.ptrace(0,1,0,0))\n"
                "import threading\nt=threading.Thread(target=lambda:None);t.start();t.join();print('threads ok')\n"
                "import subprocess;print(subprocess.run(['/bin/true']).returncode)")
        out = self.py(code)["stdout"]
        self.assertIn("userns -1 netns -1 mount -1 ptrace -1", out)
        self.assertIn("threads ok", out)
        self.assertTrue(out.strip().endswith("0"), "normal fork/exec still works")

    def test_wall_clock_timeout_kills_everything(self):
        t0 = time.time()
        status, out = self.run_job("python3", ["-c", "import subprocess,time;subprocess.Popen(['sleep','60']);time.sleep(60)"],
                                   )
        # python3's limit in the test catalog is the default 10s
        self.assertEqual(status, 200)
        self.assertTrue(out["timed_out"])
        self.assertLess(time.time() - t0, 20)
        time.sleep(0.5)
        leftovers = os.popen("pgrep -x sleep").read().split()
        self.assertEqual(leftovers, [], "the grandchild died with the sandbox")

    def test_output_flood_is_cut_and_the_program_stopped(self):
        t0 = time.time()
        out = self.py("import sys\nwhile True: sys.stdout.write('x'*65536)")
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(out["stdout"]), 64 * 1024)
        self.assertLess(time.time() - t0, 8)

    def test_memory_hog_is_killed_not_the_host(self):
        out = self.py("x=bytearray(2*1024**3);print('allocated')")
        self.assertNotIn("allocated", out["stdout"])
        self.assertNotEqual(out["status"], 0)

    def test_file_size_limit(self):
        out = self.py("f=open('big','wb')\ntry:\n    f.write(b'x'*(40*1024*1024));f.flush();print('wrote')\nexcept OSError as e:\n    print('refused')\n")
        self.assertNotEqual(out["stdout"].strip(), "wrote")

    def test_cancel_stops_a_running_job(self):
        job = "c" * 12
        result = {}

        def go():
            result["r"] = self.call("POST", "/v1/run", {"v": 1, "job": job, "user": 1, "kind": "tool", "tool": "python3", "argv": ["-c", "import time;time.sleep(30)"]})

        t = threading.Thread(target=go)
        t.start()
        for _ in range(100):
            if job in self.runner.jobs and self.runner.jobs[job].proc is not None:
                break
            time.sleep(0.05)
        time.sleep(0.3)
        t0 = time.time()
        self.assertEqual(self.call("POST", "/v1/cancel", {"job": job})[1], {"cancelled": True})
        t.join(10)
        status, out = result["r"]
        self.assertEqual(status, 200)
        self.assertTrue(out["cancelled"])
        self.assertLess(time.time() - t0, 5)
        self.assertEqual(self.call("POST", "/v1/cancel", {"job": job})[1], {"cancelled": False})

    def test_per_user_concurrency_is_limited(self):
        started = []

        def slow():
            started.append(self.run_job("python3", ["-c", "import time;time.sleep(2)"], user=1))

        threads = [threading.Thread(target=slow) for _ in range(2)]
        for t in threads:
            t.start()
        time.sleep(0.6)
        status, out = self.run_job("python3", ["-c", "print(1)"], user=1)
        self.assertEqual(status, 429, out)
        self.assertEqual(self.run_job("python3", ["-c", "print(1)"], user=2)[0], 200, "another user is not affected")
        for t in threads:
            t.join()
        self.assertEqual(self.run_job("python3", ["-c", "print(1)"], user=1)[0], 200)

    def test_bash_is_a_real_shell_inside_the_sandbox(self):
        out = self.run_job("bash", ["-c", "for i in 1 2 3; do echo -n $i; done; echo; echo hi > /work/made_by_bash.txt; cat /etc/passwd | head -1 | cut -c1-4"])[1]
        self.assertEqual(out["stdout"], "123\nuser\n")
        self.assertEqual(open(os.path.join(self.root1, "made_by_bash.txt")).read(), "hi\n")

    def test_authentication(self):
        for token in (None, "wrong", TOKEN[:-1], TOKEN + "x"):
            self.assertEqual(self.call("GET", "/v1/tools", token=token)[0], 401)
            self.assertEqual(self.call("POST", "/v1/run", {}, token=token)[0], 401)
            self.assertEqual(self.call("POST", "/v1/cancel", {"job": "x"}, token=token)[0], 401)
        self.assertEqual(self.call("GET", "/v1/health", token=None), (200, {"ok": True}))

    def test_requests_are_validated(self):
        good = {"v": 1, "job": "d" * 12, "user": 1, "kind": "tool", "tool": "python3", "argv": ["-c", "1"]}
        for patch, expected in (({"v": 2}, 400), ({"job": "../x"}, 400), ({"user": 0}, 400), ({"user": "1"}, 400), ({"user": 99}, 400),
                                ({"tool": "rm"}, 400), ({"tool": None}, 400), ({"kind": "shell"}, 400), ({"argv": "ls"}, 400),
                                ({"argv": ["a\x00b"]}, 400), ({"argv": [1]}, 400), ({"argv": ["x"] * 300}, 400), ({"env": {"A B": "1"}}, 400),
                                ({"env": {"A": 1}}, 400), ({"cwd": "relative"}, 400), ({"cwd": "/nope"}, 400), ({"stdin": 5}, 400),
                                ({"stdin": "x" * (65 * 1024)}, 400), ({"kind": "file", "path": "/documents"}, 400),
                                ({"kind": "file", "path": "/nope"}, 400)):
            status, out = self.call("POST", "/v1/run", {**good, **patch})
            self.assertEqual(status, expected, (patch, out))
        self.assertEqual(self.call("POST", "/v1/run", good)[0], 200)

    def test_cwd_and_paths_cannot_climb_out(self):
        out = self.py("import os;print(os.getcwd(), sorted(os.listdir('.')))", cwd="/documents/../../../")
        self.assertTrue(out["stdout"].startswith("/work "), out)

    def test_non_executable_and_escaping_files_are_refused(self):
        p = os.path.join(self.root1, "plain")
        open(p, "w").write("x")
        os.chmod(p, 0o644)
        os.symlink(shutil.which("true"), os.path.join(self.root1, "link_out"))
        for path in ("/plain", "/link_out"):
            self.assertEqual(self.call("POST", "/v1/run", {"v": 1, "job": "e" * 12, "user": 1, "kind": "file", "path": path})[0], 400, path)

    def test_duplicate_job_ids_and_oversized_bodies(self):
        job = "f" * 12
        t = threading.Thread(target=lambda: self.call("POST", "/v1/run", {"v": 1, "job": job, "user": 2, "kind": "tool", "tool": "python3", "argv": ["-c", "import time;time.sleep(1.5)"]}))
        t.start()
        time.sleep(0.5)
        status, _ = self.call("POST", "/v1/run", {"v": 1, "job": job, "user": 2, "kind": "tool", "tool": "python3", "argv": ["-c", "1"]})
        self.assertEqual(status, 409)
        t.join()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/v1/run")           # claims 3 MB, sends nothing: refused before reading a byte
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Length", str(3 * 1024 * 1024))
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()


def subprocess_chmod(path):
    for root, dirs, files in os.walk(path):
        os.chmod(root, 0o755)


if __name__ == "__main__":
    unittest.main()
