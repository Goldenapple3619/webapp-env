"""The virtual shell: behaviour, and the guarantee that it can only ever touch the user's files."""
import os
import tempfile
import unittest

from src.common.shell import Shell
from src.common.userfs import UserFS


class ShellTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = os.path.join(self.tmp.name, "root")
        for d in ("documents", "music"):
            os.makedirs(os.path.join(root, d))
        self.sh = Shell(UserFS(root), "alice")

    def tearDown(self):
        self.tmp.cleanup()

    def run_(self, line):
        r = self.sh.run(line)
        return r.output, r.status

    def test_navigation_and_files(self):
        self.assertEqual(self.run_("cd documents && pwd"), ("/documents\n", 0))
        self.run_("echo hello > a.txt")
        self.run_("echo world >> a.txt")
        self.assertEqual(self.run_("cat a.txt"), ("hello\nworld\n", 0))
        self.assertEqual(self.run_("cat a.txt | grep -i WORLD | wc -l"), ("1\n", 0))
        self.run_("mkdir -p x/y/z")
        self.assertIn("z", self.run_("find . -name z")[0])
        self.assertEqual(self.run_("cd /")[1], 0)

    def test_quoted_operators_are_text_not_syntax(self):
        self.run_("echo 'a|b' > pipes.txt")
        self.assertEqual(self.run_("cat pipes.txt"), ("a|b\n", 0))
        self.assertEqual(self.run_('grep "|" pipes.txt'), ("a|b\n", 0), "a quoted | is a pattern, not a pipe")
        self.assertEqual(self.run_('echo ">"'), (">\n", 0), "a quoted > is text, not a redirect")
        self.assertEqual(self.run_('echo ";" && echo "&&"'), (";\n&&\n", 0))
        self.assertEqual(self.run_('echo a"b c"d'), ("ab cd\n", 0), "quotes in the middle of a word")
        self.assertEqual(self.run_('echo "say \\"hi\\""'), ('say "hi"\n', 0))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "root", ">")), "no stray file named '>'")
        # the real operators still work
        self.assertEqual(self.run_("echo x | cat | wc -l"), ("1\n", 0))
        self.assertEqual(self.run_("echo ok ; echo again"), ("ok\nagain\n", 0))
        self.assertEqual(self.run_('echo "unterminated')[1], 2)

    def test_bad_numbers_are_usage_errors_not_internal_errors(self):
        for line in ("tree -L x", "head -n abc /nope", "tail -n -3 /nope", "tree -L 1.5"):
            out, status = self.run_(line)           # must RETURN a message: an exception here becomes a 500
            self.assertEqual(status, 1, line)
            self.assertIn("invalid number", out)
        self.run_("echo a > f.txt")
        self.assertEqual(self.run_("tail -n 0 f.txt"), ("", 0), "tail -n 0 prints nothing (not everything)")
        self.assertEqual(self.run_("head -n 0 f.txt"), ("", 0))

    def test_grep_reports_files_it_cannot_read(self):
        self.run_("echo foo > a.txt")
        self.assertEqual(self.run_("grep foo nope.txt"), ("grep: /nope.txt: not found\n", 2), "used to print nothing and succeed")
        out, status = self.run_("grep foo a.txt nope.txt")
        self.assertEqual((out, status), ("/a.txt:foo\ngrep: /nope.txt: not found\n", 2), "matches first, then the errors")
        self.assertEqual(self.run_("grep foo a.txt"), ("foo\n", 0))

    def test_a_failing_redirect_is_a_shell_error(self):
        out, status = self.run_("echo hi > no/such/dir/f.txt")   # used to raise: the whole command failed as an app error
        self.assertEqual(status, 1)
        self.assertIn("not found", out)
        self.assertEqual(self.run_("echo hi > documents && echo after")[1], 1)

    def test_sandbox(self):
        self.assertEqual(self.run_("cd /../../etc")[1], 1)       # clamped to <user root>/etc, which does not exist
        self.assertEqual(self.sh.cwd, "/")
        self.assertEqual(self.run_("cat /etc/passwd")[1], 1)
        self.assertEqual(self.run_("ls /etc")[1], 1)
        for cmd in ("python -c 'print(1)'", "bash", "sh -c id", "curl http://x", "rm -rf --no-preserve-root /"):
            self.assertEqual(self.run_(cmd)[1], 127 if not cmd.startswith("rm") else 1, cmd)

    def test_protected_and_errors(self):
        self.assertEqual(self.run_("rm -r /documents")[1], 1)
        self.assertEqual(self.run_("rm /nope")[1], 1)
        self.assertEqual(self.run_("rm -f /nope")[1], 0)
        self.assertEqual(self.run_("echo 'unterminated")[1], 2)

    def test_chaining(self):
        self.assertEqual(self.run_("echo a; echo b")[0], "a\nb\n")
        out, status = self.run_("nosuch && echo never")
        self.assertNotIn("never", out)
        self.assertEqual(status, 127)

    def test_actions_for_the_client(self):
        self.run_("echo x > f.txt")
        r = self.sh.run("open f.txt")
        self.assertEqual(r.actions[0]["path"], "/f.txt")
        self.assertEqual(self.sh.run("play f.txt").actions[0]["app"], "music")
        self.assertTrue(self.sh.run("clear").clear)

    def test_completion(self):
        self.run_("touch alpha beta")
        self.assertEqual(self.sh.complete("cat al"), ["alpha"])
        self.assertIn("cat", self.sh.complete("ca"))
        self.assertEqual(self.sh.complete("cd doc"), ["documents/"])

    def test_output_is_capped(self):
        self.run_("echo seed > big.txt")
        self.sh.fs.write_text("/big.txt", "x" * 400_000, create=True)
        out, _ = self.run_("cat big.txt")
        self.assertLess(len(out), 300_000)


if __name__ == "__main__":
    unittest.main()
