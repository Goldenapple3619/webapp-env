"""Unit tests of the filesystem sandbox (no network, no database)."""
import os
import tempfile
import unittest

from src.common.userfs import FsError, UserFS, normalize, valid_name


class NormalizeTests(unittest.TestCase):
    def test_collapses_and_clamps(self):
        self.assertEqual(normalize("/a//b/../c"), "/a/c")
        self.assertEqual(normalize("//documents"), "/documents")      # posixpath.normpath keeps '//': we must not
        self.assertEqual(normalize("../../.."), "/")
        self.assertEqual(normalize("a\\b"), "/a/b")
        self.assertEqual(normalize(""), "/")
        self.assertEqual(normalize(None), "/")

    def test_nul_rejected(self):
        with self.assertRaises(FsError):
            normalize("a\0b")

    def test_valid_name(self):
        for bad in ("", ".", "..", "a/b", "a\\b", "a\0", "x" * 256, None, 5):
            self.assertFalse(valid_name(bad), repr(bad))
        self.assertTrue(valid_name("ok name (1).txt"))


class FsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "root")
        for d in ("documents", "music", "other"):
            os.makedirs(os.path.join(self.root, d))
        self.fs = UserFS(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_cannot_escape(self):
        for evil in ("../../etc/passwd", "/../..", "documents/../../.."):
            self.assertTrue(self.fs.resolve(evil).startswith(self.fs.root), evil)

    def test_symlink_escape_is_blocked(self):
        os.symlink("/etc", os.path.join(self.root, "documents", "link"))
        with self.assertRaises(FsError) as e:
            self.fs.stat("/documents/link/passwd")
        self.assertEqual(e.exception.code, "not_found")

    def test_mkfile_never_truncates(self):
        self.fs.mkfile("/documents", "a.txt")
        self.fs.write_text("/documents/a.txt", "precious")
        with self.assertRaises(FsError) as e:
            self.fs.mkfile("/documents", "a.txt")          # the first version opened with 'wb+' and destroyed the file
        self.assertEqual(e.exception.code, "exists")
        self.assertEqual(self.fs.read_text("/documents/a.txt")["content"], "precious")

    def test_system_folders_are_protected(self):
        for op in (lambda: self.fs.delete("/documents"), lambda: self.fs.rename("/music", "x"), lambda: self.fs.delete("/")):
            with self.assertRaises(FsError) as e:
                op()
            self.assertEqual(e.exception.code, "forbidden")

    def test_move_copy_rules(self):
        self.fs.mkdir("/documents", "d")
        self.fs.mkfile("/documents/d", "f.txt")
        with self.assertRaises(FsError) as e:
            self.fs.move(["/documents/d"], "/documents/d")  # into itself
        self.assertEqual(e.exception.code, "invalid_move")
        self.assertEqual(self.fs.copy(["/documents/d/f.txt"], "/documents/d"), ["/documents/d/f (copy).txt"])
        self.assertEqual(self.fs.copy(["/documents/d/f.txt"], "/documents/d"), ["/documents/d/f (copy 2).txt"])
        self.fs.mkfile("/other", "f.txt")
        with self.assertRaises(FsError) as e:
            self.fs.move(["/other/f.txt"], "/documents/d")  # name taken: never overwrite silently
        self.assertEqual(e.exception.code, "exists")

    def test_write_conflict_detection(self):
        r = self.fs.write_text("/documents/n.txt", "v1", create=True)
        self.fs.write_text("/documents/n.txt", "v2", base_mtime=r["mtime"])
        os.utime(self.fs.resolve("/documents/n.txt"), (1, 1))        # somebody else touched it
        with self.assertRaises(FsError) as e:
            self.fs.write_text("/documents/n.txt", "v3", base_mtime=r["mtime"])
        self.assertEqual(e.exception.code, "conflict")
        self.fs.write_text("/documents/n.txt", "v3", base_mtime=r["mtime"], force=True)
        self.assertEqual(self.fs.read_text("/documents/n.txt")["content"], "v3")

    def test_read_text_limits_and_eol(self):
        with open(os.path.join(self.root, "documents", "b.bin"), "wb") as f:
            f.write(b"\x00\x01")
        with self.assertRaises(FsError) as e:
            self.fs.read_text("/documents/b.bin")
        self.assertEqual(e.exception.code, "binary")
        self.fs.write_text("/documents/w.txt", "a\nb\n", eol="crlf", create=True)
        r = self.fs.read_text("/documents/w.txt")
        self.assertEqual((r["eol"], r["content"]), ("crlf", "a\nb\n"))   # normalised in the editor, restored on save

    def test_atomic_write_leaves_no_temp_files(self):
        self.fs.write_text("/documents/t.txt", "x", create=True)
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "documents"))), ["t.txt"])


if __name__ == "__main__":
    unittest.main()
