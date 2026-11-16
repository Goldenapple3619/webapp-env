"""Shell language (variables, globbing, scripts), the /virtual mount and how real tools are driven (with a fake runner)."""
import os
import tempfile
import threading
import unittest

from src.common.runner import RunnerError
from src.common.shell import Shell
from src.common.userfs import UserFS
from src.common.virtualfs import VirtualFS


class FakeRunner:
    enabled = True

    def __init__(self, tools=("gcc", "python3")):
        self.names, self.requests, self.reply, self.error = tools, [], {"status": 0, "stdout": "", "stderr": ""}, None

    def tools(self, force=False):
        return {"sandbox": "fake", "tools": [{"name": n, "description": f"the {n} tool", "version": "1.0", "limits": {"wall_s": 10}} for n in self.names]}

    def run(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return dict(self.reply)

    def cancel(self, job):
        return True


class Base(unittest.TestCase):
    runner = None

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        for d in ("documents", "music"):
            os.makedirs(os.path.join(self.root, d))
        self.audit = []
        self.sh = Shell(UserFS(self.root), "alice", runner=self.runner, user_id=7, audit=self.audit.append)

    def tearDown(self):
        self.tmp.cleanup()

    def run_(self, line):
        r = self.sh.run(line)
        return r.output, r.status

    def write(self, path, text, executable=False):
        self.sh.fs.write_text(path, text, create=True)
        if executable:
            self.sh.fs.chmod(path, True)


class Language(Base):
    def test_variables_and_quoting(self):
        self.run_("NAME=world")
        self.assertEqual(self.run_('echo "hello $NAME" ${NAME}!'), ("hello world world!\n", 0))
        self.assertEqual(self.run_("echo '$NAME' \\$NAME"), ("$NAME $NAME\n", 0), "single quotes and backslash prevent expansion")
        self.assertEqual(self.run_("echo [$UNSET_X]"), ("[]\n", 0))
        self.run_("false")
        self.assertEqual(self.run_("echo $?")[0], "1\n")
        self.assertEqual(self.run_("echo $USER $HOME $PWD"), ("alice / /\n", 0))
        self.assertEqual(self.run_('echo "\\$NAME"')[0], "$NAME\n")

    def test_a_quoted_variable_is_never_a_path_trick(self):
        self.run_("X='../../etc'")
        self.assertEqual(self.run_("cat $X/passwd")[1], 1)
        self.assertEqual(self.run_("cd $X")[1], 1)

    def test_or_and_comments(self):
        self.assertEqual(self.run_("false || echo rescued"), ("rescued\n", 0))
        self.assertEqual(self.run_("true || echo no"), ("", 0))
        self.assertEqual(self.run_("echo a # not this"), ("a\n", 0))
        self.assertEqual(self.run_("echo a#b"), ("a#b\n", 0), "a # inside a word is not a comment")
        self.assertEqual(self.run_("# only a comment"), ("", 0))

    def test_unsupported_operators_are_explained(self):
        out, status = self.run_("sleep 5 &")
        self.assertEqual(status, 2)
        self.assertIn("background", out)
        self.assertEqual(self.run_("echo a 2>&1")[1], 2)

    def test_globbing(self):
        for name in ("a.c", "b.c", "c.h", ".hidden.c"):
            self.run_(f"touch documents/{name}")
        self.assertEqual(self.run_("echo documents/*.c"), ("documents/a.c documents/b.c\n", 0))
        self.assertEqual(self.run_("cd documents && echo *.?"), ("a.c b.c c.h\n", 0))
        self.assertEqual(self.run_("echo *.zzz"), ("*.zzz\n", 0), "no match stays literal")
        self.assertEqual(self.run_("echo '*.c'"), ("*.c\n", 0), "quoted wildcards do nothing")
        self.assertEqual(self.run_("echo /documents/[ab].c"), ("/documents/a.c /documents/b.c\n", 0))
        self.assertEqual(self.run_("echo /doc*/a.c"), ("/documents/a.c\n", 0))
        self.run_("rm *.c")
        self.assertIn(".hidden.c", self.run_("ls -a")[0], "a * never matches dotfiles, so rm *.c left it")
        self.assertNotIn("a.c", self.run_("ls")[0])

    def test_input_redirect_and_dev_null(self):
        self.write("/documents/in.txt", "b\na\n")
        self.assertEqual(self.run_("sort < documents/in.txt"), ("a\nb\n", 0))
        self.assertEqual(self.run_("echo gone > /dev/null"), ("", 0))
        self.assertFalse(os.path.exists(os.path.join(self.root, "dev")))
        self.assertEqual(self.run_("sort < nope.txt")[1], 1)

    def test_exported_variables_only(self):
        self.run_("A=1")
        self.run_("export B=2")
        env = self.run_("env")[0]
        self.assertIn("B=2", env)
        self.assertNotIn("A=1", env)


class Scripts(Base):
    def test_sh_dash_c_and_positional_parameters(self):
        self.assertEqual(self.run_("sh -c 'echo hi; echo $0 $1 $#' name x"), ("hi\nname x 1\n", 0))
        self.assertEqual(self.run_("/virtual/sh -c 'echo direct'"), ("direct\n", 0))

    def test_script_file_with_arguments_comments_and_continuations(self):
        self.write("/documents/s.sh", "# a script\ncd /music\necho in $PWD\necho one \\\n  two\necho args: $@ ($#)\n")
        self.assertEqual(self.run_("sh documents/s.sh a b"), ("in /music\none two\nargs: a b (2)\n", 0))
        self.assertEqual(self.sh.cwd, "/", "cd inside a script does not leak into the calling shell")

    def test_source_runs_in_the_current_shell(self):
        self.write("/documents/env.sh", "cd /music\nMODE=on\n")
        self.run_("source documents/env.sh")
        self.assertEqual(self.sh.cwd, "/music")
        self.assertEqual(self.run_(". /documents/env.sh && echo $MODE")[0], "on\n")

    def test_shebang_needs_the_executable_bit(self):
        self.write("/documents/run.sh", "#!/virtual/sh\necho ran $1\n")
        out, status = self.run_("./documents/run.sh")
        self.assertEqual(status, 126)
        self.assertIn("permission denied", out)
        self.assertEqual(self.run_("chmod +x documents/run.sh"), ("", 0))
        self.assertEqual(self.run_("./documents/run.sh x"), ("ran x\n", 0))
        self.assertEqual(self.run_("chmod -x documents/run.sh")[1], 0)
        self.assertEqual(self.run_("./documents/run.sh")[1], 126)

    def test_exit_and_set_e(self):
        self.assertEqual(self.run_("sh -c 'echo a; exit 3; echo b'"), ("a\n", 3))
        self.assertEqual(self.run_("sh -c 'false; echo still'"), ("still\n", 0))
        self.assertEqual(self.run_("sh -e -c 'false; echo never'"), ("", 1))
        self.assertEqual(self.run_("sh -c 'set -e; echo x; false; echo never'"), ("x\n", 1))

    def test_a_script_cannot_loop_the_server(self):
        self.write("/documents/loop.sh", "sh /documents/loop.sh\n")
        out, status = self.run_("sh documents/loop.sh")
        self.assertIn("nested too deeply", out)
        many = "\n".join(["echo x"] * 3000)
        self.write("/documents/many.sh", many)
        out, _ = self.run_("sh documents/many.sh")
        self.assertIn("too many commands", out)
        self.assertLess(out.count("x"), 2100)

    def test_stdin_script(self):
        self.assertEqual(self.run_("echo 'echo from stdin' | sh"), ("from stdin\n", 0))

    def test_bad_interpreter_and_non_programs(self):
        self.write("/documents/a.sh", "#!/bin/zsh\necho hi\n", executable=True)
        self.assertEqual(self.run_("./documents/a.sh")[1], 126)
        self.write("/documents/note.txt", "just text\n", executable=True)
        out, status = self.run_("./documents/note.txt")
        self.assertEqual(status, 126)
        self.assertIn("cannot execute", out)


class VirtualMount(Base):
    runner = FakeRunner()

    def test_virtual_is_listable_readable_and_statable(self):
        out, status = self.run_("ls /virtual")
        self.assertEqual(status, 0)
        for name in ("sh", "gcc", "python3"):
            self.assertIn(name, out)
        self.assertIn("#!/virtual/sh", self.run_("cat /virtual/sh")[0])
        self.assertIn("gcc", self.run_("cat /virtual/gcc")[0])
        self.assertIn("/work", self.run_("cat /virtual/gcc")[0])
        self.assertIn("(executable)", self.run_("stat /virtual/sh")[0])
        self.assertEqual(self.run_("cd /virtual && pwd"), ("/virtual\n", 0))
        self.assertEqual(self.run_("ls /virtual/nope")[1], 1)

    def test_virtual_is_read_only(self):
        for line in ("rm /virtual/sh", "touch /virtual/x", "echo x > /virtual/sh", "mkdir /virtual/d", "cp /documents /virtual", "chmod -x /virtual/sh"):
            out, status = self.run_(line)
            self.assertEqual(status, 1, line)
        self.assertEqual(self.run_("ls /virtual")[1], 0)

    def test_path_lookup_which_and_completion(self):
        self.assertEqual(self.run_("which gcc"), ("/virtual/gcc\n", 0))
        self.assertEqual(self.run_("which sh"), ("/virtual/sh\n", 0))
        self.assertEqual(self.run_("which echo"), ("echo: shell builtin\n", 0))
        self.assertEqual(self.run_("which nothing")[1], 1)
        self.assertIn("gcc", self.sh.complete("gc"))
        self.assertEqual(self.sh.complete("cat /virtual/py"), ["/virtual/python3"])

    def test_tools_listing(self):
        out, _ = self.run_("tools")
        self.assertIn("/virtual/gcc", out)
        self.assertIn("/virtual/sh", out)
        self.assertIn("no network", out)

    def test_nothing_can_create_the_name(self):
        self.assertEqual(self.run_("mkdir /virtual")[1], 1)

    def test_vfs_standalone(self):
        vfs = VirtualFS(FakeRunner(("gcc",)))
        self.assertEqual([e["name"] for e in vfs.listdir()["content"]], ["sh", "gcc"])
        self.assertTrue(vfs.stat("/virtual")["type"] == "folder")


class RealTools(Base):
    runner = FakeRunner()

    def setUp(self):
        super().setUp()
        self.runner.requests.clear()
        self.runner.error = None
        self.runner.reply = {"status": 0, "stdout": "", "stderr": ""}

    def test_a_tool_receives_translated_paths_cwd_and_stdin(self):
        self.run_("cd /documents")
        self.runner.reply = {"status": 0, "stdout": "ok\n", "stderr": ""}
        self.assertEqual(self.run_("gcc main.c -o /documents/app -I/documents/inc -lm --out=/x"), ("ok\n", 0))
        req = self.runner.requests[0]
        self.assertEqual((req["kind"], req["tool"], req["user"], req["cwd"]), ("tool", "gcc", 7, "/documents"))
        self.assertEqual(req["argv"], ["main.c", "-o", "/work/documents/app", "-I/work/documents/inc", "-lm", "--out=/work/x"])
        self.run_("echo 5 | python3 -")
        self.assertEqual(self.runner.requests[1]["stdin"], "5\n")
        self.assertTrue(self.runner.requests[1]["merge"], "last stage = the terminal")

    def test_wildcards_expand_before_the_tool_sees_them(self):
        self.run_("touch a.c b.c")
        self.run_("gcc *.c")
        self.assertEqual(self.runner.requests[-1]["argv"], ["a.c", "b.c"])

    def test_output_paths_are_shown_the_way_the_user_thinks_of_them(self):
        self.runner.reply = {"status": 1, "stdout": "", "stderr": "/work/documents/a.c:3:1: error: oops\n/work: /workspace stays\n"}
        out, status = self.run_("gcc a.c")
        self.assertEqual(status, 1)
        self.assertIn("/documents/a.c:3:1: error: oops", out)
        self.assertIn("/workspace stays", out)
        self.assertNotIn("/work/documents", out)

    def test_stderr_is_not_piped_but_still_shown(self):
        self.runner.reply = {"status": 0, "stdout": "x\n", "stderr": "warning\n"}
        self.assertEqual(self.run_("gcc a.c | wc -l"), ("warning\n1\n", 0))
        self.assertFalse(self.runner.requests[0]["merge"])
        self.run_("gcc a.c")
        self.assertTrue(self.runner.requests[1]["merge"], "straight to the terminal: ordering is kept by the sandbox")

    def test_env_only_what_was_exported(self):
        self.run_("SECRET=1")
        self.run_("export CFLAGS=-O2")
        self.run_("MODE=fast gcc a.c")
        env = self.runner.requests[-1]["env"]
        self.assertEqual(env, {"CFLAGS": "-O2", "MODE": "fast"})

    def test_failures_become_messages_with_exit_codes(self):
        cases = [({"status": 0, "timed_out": True, "wall_limit": 10}, 124, "time limit"),
                 ({"status": -9, "signal": "SIGKILL"}, 0, "out of memory"),
                 ({"status": 130, "cancelled": True}, 130, "interrupted"),
                 ({"status": 0, "truncated": True}, 0, "truncated")]
        for reply, status, text in cases:
            self.runner.reply = {"stdout": "", "stderr": "", **reply}
            out, got = self.run_("python3 x.py")
            self.assertIn(text, out)
            if status:
                self.assertEqual(got, status)
        for code, text in (("busy", "busy"), ("unavailable", "did not answer"), ("denied", "RUNNER_TOKEN")):
            self.runner.error = RunnerError(code, "the sandbox runner did not answer (X)")
            out, got = self.run_("python3 x.py")
            self.assertEqual(got, 126)
            self.assertIn(text, out)

    def test_programs_built_by_the_user_run_through_the_sandbox(self):
        os.makedirs(os.path.join(self.root, "bin"))
        elf = os.path.join(self.root, "bin", "app")
        with open(elf, "wb") as fp:
            fp.write(b"\x7fELF" + b"\0" * 60)
        os.chmod(elf, 0o755)
        self.assertEqual(self.run_("./bin/app one")[1], 0)
        req = self.runner.requests[-1]
        self.assertEqual((req["kind"], req["path"], req["argv"]), ("file", "/bin/app", ["one"]))
        os.chmod(elf, 0o644)
        self.assertEqual(self.run_("./bin/app")[1], 126)

    def test_shebang_to_a_tool(self):
        self.write("/documents/t.py", "#!/virtual/python3\nprint(1)\n", executable=True)
        self.run_("./documents/t.py a")
        req = self.runner.requests[-1]
        self.assertEqual((req["tool"], req["argv"]), ("python3", ["/work/documents/t.py", "a"]))
        self.write("/documents/e.py", "#!/usr/bin/env python3\nprint(1)\n", executable=True)
        self.run_("./documents/e.py")
        self.assertEqual(self.runner.requests[-1]["tool"], "python3")

    def test_audit_trail(self):
        self.runner.reply = {"status": 2, "stdout": "", "stderr": ""}
        self.run_("gcc broken.c")
        self.assertEqual((self.audit[-1]["tool"], self.audit[-1]["status"], self.audit[-1]["outcome"]), ("gcc", 2, "exit"))

    def test_needs_runner_decides_who_may_block(self):
        for line, expected in (("ls", False), ("echo hi | wc -l", False), ("cd /music && pwd", False), ("gcc a.c", True),
                               ("ls; gcc a.c", True), ("sh -c 'x'", True), ("./a.out", False), ("source x", True), ("$CC a.c", True),
                               ("FOO=1 gcc a.c", True), ("nosuchthing", False), ("echo 'unterminated", False), ("which gcc", False)):
            self.assertEqual(self.sh.needs_runner(line), expected, line)

    def test_an_interrupted_line_stops_before_the_next_command(self):
        stop = threading.Event()
        stop.set()
        r = self.sh.run("gcc a.c && echo never", cancel=stop)
        self.assertNotIn("never", r.output)
        self.assertEqual(self.runner.requests, [])


class NoRunner(Base):
    def test_known_tools_explain_themselves(self):
        for cmd in ("gcc", "python3", "bash"):
            out, status = self.run_(cmd + " x")
            self.assertEqual(status, 127)
            self.assertIn("not available here", out)
        self.assertEqual(self.run_("nonsense")[0], "nonsense: command not found\n")
        self.assertEqual(self.run_("./nonsense")[0], "./nonsense: No such file or directory\n")
        self.assertEqual(self.run_("ls /virtual | cat"), ("sh*\n", 0))
        self.assertIn("no real tools", self.run_("tools")[0])
        self.assertEqual(self.run_("sh -c 'echo works without a runner'"), ("works without a runner\n", 0))


if __name__ == "__main__":
    unittest.main()
