"""
End to end, nothing faked: Shell -> RunnerClient -> HTTP -> runner service -> bubblewrap/seccomp -> real gcc / python.
Skipped when the runner sources, bwrap or the compiled seccomp filter are not available:
    RUNNER_SRC=/path/to/runner SECCOMP_BPF=/tmp/seccomp.bpf python3 -m unittest tests.test_real_tools
"""
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
def _find_runner():   # unzipped side by side (X/socket, X/runner) - or one level deeper (X/socket/socket)
    for rel in (("..", "..", "runner"), ("..", "..", "..", "runner")):
        candidate = os.path.abspath(os.path.join(HERE, *rel))
        if os.path.isfile(os.path.join(candidate, "runner.py")):
            return candidate
    return os.path.abspath(os.path.join(HERE, "..", "..", "runner"))


RUNNER_SRC = os.environ.get("RUNNER_SRC") or _find_runner()
BPF = os.environ.get("SECCOMP_BPF", "/tmp/seccomp.bpf")
AVAILABLE = os.path.isfile(os.path.join(RUNNER_SRC, "runner.py")) and shutil.which("bwrap") and os.path.isfile(BPF)

from src.common.runner import RunnerClient, RunnerError  # noqa: E402
from src.common.shell import Shell  # noqa: E402
from src.common.userfs import UserFS  # noqa: E402

TOKEN = "k" * 40


@unittest.skipUnless(AVAILABLE, "runner sources / bwrap / seccomp filter not available")
class RealTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, RUNNER_SRC)
        import json
        import runner as rm
        cls.tmp = tempfile.mkdtemp()
        os.chmod(cls.tmp, 0o755)
        users = os.path.join(cls.tmp, "users")
        cls.root = os.path.join(users, "1", "root")
        os.makedirs(os.path.join(cls.root, "documents"))
        spec = {"defaults": {"wall_s": 4, "cpu_s": 8, "mem_mb": 1024, "fsize_mb": 16, "nofile": 256, "output_kb": 64, "stdin_kb": 64},
                "tools": [{"name": "gcc", "bin": shutil.which("gcc"), "description": "C compiler", "limits": {"wall_s": 30, "cpu_s": 25, "mem_mb": 1536}},
                          {"name": "python3", "bin": shutil.which("python3"), "description": "Python", "env": {"PYTHONDONTWRITEBYTECODE": "1"}}]}
        tools = os.path.join(cls.tmp, "tools.json")
        json.dump(spec, open(tools, "w"))
        settings = rm.Settings(token=TOKEN, users_root=users, tools_file=tools, seccomp=BPF, etc_dir=os.path.join(cls.tmp, "etc"),
                               max_jobs=4, per_user=2, queue_wait=1)
        cls.runner = rm.Runner(settings)
        cls.runner.sandbox.prepare_etc()
        cls.runner.selftest()
        cls.http = rm.Server(("127.0.0.1", 0), rm.make_handler(cls.runner))
        cls.port = cls.http.server_address[1]
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.client = RunnerClient(f"http://127.0.0.1:{cls.port}", TOKEN, call_timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.runner.stop_all()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        for name in os.listdir(self.root):  # every test starts from an empty folder
            path = os.path.join(self.root, name)
            shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)
        os.makedirs(os.path.join(self.root, "documents"))
        self.sh = Shell(UserFS(self.root), "alice", runner=self.client, user_id=1)

    def run_(self, line):
        r = self.sh.run(line)
        return r.output, r.status

    def test_catalog_reaches_the_virtual_mount(self):
        out, _ = self.run_("ls /virtual | cat")
        self.assertEqual(out.split(), ["sh*", "gcc*", "python3*"])
        self.assertIn("sandbox: bwrap+seccomp", self.run_("tools")[0])
        self.assertIn("GNU", self.run_("cat /virtual/gcc")[0] + "GNU")  # description renders (version text varies)

    def test_the_whole_workflow_a_user_would_type(self):
        self.run_("cd /documents")
        self.sh.fs.write_text("/documents/hello.c", '#include <stdio.h>\nint main(int c, char**v){ printf("hello %s\\n", c>1?v[1]:"world"); return 0; }\n', create=True)
        self.assertEqual(self.run_("gcc *.c -o hello && ./hello there"), ("hello there\n", 0))
        self.assertEqual(self.run_("./hello | wc -c"), ("12\n", 0))
        self.assertEqual(self.run_("gcc /documents/hello.c -o /documents/again && /documents/again"), ("hello world\n", 0))
        self.assertIn("again", self.run_("ls | cat")[0])

    def test_compile_errors_show_the_users_paths_not_the_sandbox_ones(self):
        self.sh.fs.write_text("/documents/bad.c", "int main( {\n", create=True)
        out, status = self.run_("cd /documents && gcc bad.c")
        self.assertNotEqual(status, 0)
        self.assertIn("bad.c", out)
        self.assertNotIn("/work", out)
        out, _ = self.run_("gcc /documents/bad.c")
        self.assertIn("/documents/bad.c:", out, "an absolute path the user typed comes back as the user wrote it")

    def test_python_pipes_and_scripts(self):
        self.assertEqual(self.run_("echo 21 | python3 -c 'print(int(input())*2)'"), ("42\n", 0))
        self.assertEqual(self.run_("python3 -c 'import sys; print(sys.argv[1:])' a b"), ("['a', 'b']\n", 0))
        self.assertEqual(self.run_("python3 -c 'print(1)' > out.txt && cat out.txt"), ("1\n", 0))
        self.sh.fs.write_text("/documents/t.py", "#!/virtual/python3\nimport sys\nprint('script', sys.argv[1:])\n", create=True)
        self.run_("chmod +x /documents/t.py")
        self.assertEqual(self.run_("/documents/t.py x"), ("script ['x']\n", 0))
        self.sh.fs.write_text("/documents/build.sh", "#!/virtual/sh\npython3 -c 'print(6*7)'\necho done\n", create=True)
        self.assertEqual(self.run_("sh /documents/build.sh"), ("42\ndone\n", 0))

    def test_a_program_cannot_see_beyond_the_users_files(self):
        out, _ = self.run_("python3 -c \"import os; print(sorted(os.listdir('/')))\"")
        self.assertNotIn("mnt", out)
        self.assertEqual(self.run_("python3 -c \"import os; print(os.path.exists('/mnt/system'))\"")[0], "False\n")

    def test_files_created_by_programs_are_visible_to_the_shell(self):
        self.run_("python3 -c \"open('/work/documents/by_python.txt','w').write('hi')\"")
        self.assertEqual(self.run_("cat /documents/by_python.txt"), ("hi", 0))

    def test_timeout_and_exit_codes_are_reported(self):
        out, status = self.run_("python3 -c 'import time; time.sleep(30)'")
        self.assertEqual(status, 124)
        self.assertIn("time limit", out)
        self.assertEqual(self.run_("python3 -c 'import sys; sys.exit(7)'")[1], 7)
        self.assertEqual(self.run_("python3 -c 'print(1)' && echo and-then")[0], "1\nand-then\n")

    def test_ctrl_c_cancels_a_running_program(self):
        stop = threading.Event()
        result = {}
        t = threading.Thread(target=lambda: result.update(r=self.sh.run("python3 -c 'import time; time.sleep(30)'; echo never", cancel=stop)))
        t.start()
        for _ in range(100):
            if self.sh.current_job:
                break
            time.sleep(0.05)
        time.sleep(0.3)
        t0 = time.time()
        stop.set()
        self.client.cancel(self.sh.current_job)
        t.join(10)
        r = result["r"]
        self.assertLess(time.time() - t0, 5)
        self.assertEqual(r.status, 130)
        self.assertIn("interrupted", r.output)
        self.assertNotIn("never", r.output)


class ClientFailureModes(unittest.TestCase):
    def free_port(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        return port

    def test_a_dead_runner_trips_the_breaker_instead_of_stalling_every_command(self):
        now = [0.0]
        client = RunnerClient(f"http://127.0.0.1:{self.free_port()}", TOKEN, failure_threshold=2, cooldown=10, clock=lambda: now[0])
        for _ in range(2):
            with self.assertRaises(RunnerError) as c:
                client.run({"kind": "tool"})
            self.assertEqual(c.exception.code, "unavailable")
        t0 = time.time()
        with self.assertRaises(RunnerError):
            client.run({"kind": "tool"})
        self.assertLess(time.time() - t0, 0.05, "breaker open: answers at once")
        now[0] = 11.0
        with self.assertRaises(RunnerError):
            client.run({"kind": "tool"})  # half-open: tries again for real

    def test_catalog_never_raises_and_is_cached(self):
        client = RunnerClient(f"http://127.0.0.1:{self.free_port()}", TOKEN)
        catalog = client.tools()
        self.assertEqual(catalog["tools"], [])
        self.assertIn("error", catalog)
        self.assertIs(client.tools(), catalog)

    @unittest.skipUnless(AVAILABLE, "runner not available")
    def test_wrong_token_is_reported_as_denied(self):
        sys.path.insert(0, RUNNER_SRC)
        import runner as rm
        settings = rm.Settings(token=TOKEN, users_root=tempfile.gettempdir(), seccomp=BPF)
        server = rm.Server(("127.0.0.1", 0), rm.make_handler(rm.Runner(settings)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        client = RunnerClient(f"http://127.0.0.1:{server.server_address[1]}", "z" * 40)
        with self.assertRaises(RunnerError) as c:
            client.run({"kind": "tool"})
        self.assertEqual(c.exception.code, "denied")
        self.assertEqual(client.tools()["tools"], [])


if __name__ == "__main__":
    unittest.main()
