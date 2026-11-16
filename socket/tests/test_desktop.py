import json
import os
import shutil
import tempfile
import unittest

from src import AppError
from src.network.wsserver import AppContext
from src.common import shortcut as sc
from src.common.appearance import AppearanceError, normalize_appearance, normalize_layout
from src.common.userfs import FsError, UserFS
from apps.desktopApp import DesktopApp


class ShortcutFormat(unittest.TestCase):
    def test_minimal_example_from_the_spec(self):
        s, warnings = sc.parse('<shortcut name="Music" icon="" open="music">\n    \n</shortcut>')
        self.assertEqual((s["name"], s["icon"], s["open"], s["args"], warnings), ("Music", "", "music", [], []))

    def test_round_trip_keeps_args_order_types_and_escapes(self):
        data = {"name": 'A "quoted" <name>', "icon": "/pictures/i.png", "open": "music", "comment": "x & y",
                "args": [{"name": "queue", "value": "/a&b.mp3"}, {"name": "queue", "value": "/c.mp3"},
                         {"name": "n", "type": "number", "value": "3"}, {"name": "f", "type": "boolean", "value": "true"}],
                "window": {"width": 500, "height": 300, "maximized": True}}
        parsed, warnings = sc.parse(sc.serialize(data))
        self.assertEqual(warnings, [])
        self.assertEqual(parsed, sc.normalize(data))
        self.assertEqual([a["value"] for a in parsed["args"] if a["name"] == "queue"], ["/a&b.mp3", "/c.mp3"])

    def test_target_only_shortcut_is_valid_but_empty_is_not(self):
        self.assertEqual(sc.normalize({"name": "n", "target": "/documents/a.txt"})["open"], "")
        with self.assertRaises(sc.ShortcutError):
            sc.normalize({"name": "n"})

    def test_hostile_documents_are_rejected(self):
        bomb = '<!DOCTYPE a [<!ENTITY x "aaaa"><!ENTITY y "&x;&x;&x;&x;">]><shortcut name="a" open="b">&y;</shortcut>'
        for text, code in ((bomb, "forbidden_markup"), ("<shortcut", "invalid_xml"), ("<other name='a'/>", "invalid_xml"),
                           ("x" * (sc.MAX_BYTES + 1), "too_large"), ("<shortcut name='a' open='b'>\x00</shortcut>", "not_text")):
            with self.assertRaises(sc.ShortcutError, msg=text[:30]) as ctx:
                sc.parse(text)
            self.assertEqual(ctx.exception.code, code)

    def test_field_validation(self):
        base = {"name": "n", "open": "music"}
        for patch in ({"open": "../x"}, {"icon": "javascript:1"}, {"target": "relative.txt"}, {"name": ""}, {"name": "a\x01"},
                      {"args": [{"name": "1bad", "value": "x"}]}, {"args": [{"name": "n", "type": "number", "value": "abc"}]},
                      {"args": [{"name": "n", "type": "boolean", "value": "maybe"}]}, {"window": {"width": 5}},
                      {"args": [{"name": "a", "value": "x"}] * 33}):
            with self.assertRaises(sc.ShortcutError, msg=str(patch)):
                sc.normalize({**base, **patch})

    def test_unknown_content_is_reported_not_silently_lost(self):
        _, warnings = sc.parse('<shortcut name="a" open="b" colour="red"><extra/></shortcut>')
        self.assertEqual(len(warnings), 2)


class AppearanceValidation(unittest.TestCase):
    def test_normalizes_colours_and_numbers(self):
        out = normalize_appearance({"colors": {"--accent": "#F8B"}, "taskbar": {"height": 44.4, "labels": False},
                                    "apps": {"terminal": {"vars": {"--tm-size": 13.456, "--tm-bg": "#123456"}}}})
        self.assertEqual(out["colors"]["--accent"], "#ff88bb")
        self.assertEqual(out["taskbar"]["height"], 44)
        self.assertEqual(out["apps"]["terminal"]["vars"]["--tm-size"], 13.46)

    def test_nothing_that_could_be_css_or_script_gets_through(self):
        evil = ["red", "url(javascript:alert(1))", "#fff; background:url(x)", "expression(1)", "#ggg", "}body{", 'a" onload="x', None, 5, "#12"]
        for value in evil:
            with self.assertRaises(AppearanceError, msg=repr(value)):
                normalize_appearance({"colors": {"--accent": value}})
        for key in ("accent", "--Accent", "--a;b", "--", "--" + "a" * 60, "--a b"):
            with self.assertRaises(AppearanceError, msg=key):
                normalize_appearance({"colors": {key: "#ffffff"}})
        for bad in ({"desktop": {"image": "http://evil/x.png"}}, {"desktop": {"image": "/a\\b"}}, {"desktop": {"mode": "video"}},
                    {"taskbar": {"height": 500}}, {"windows": {"radius": -1}}, {"windows": {"shadow": "glow"}},
                    {"apps": {"a b": {}}}, {"apps": {"x": {"vars": {"--v": float("nan")}}}}, {"taskbar": {"labels": "yes"}}):
            with self.assertRaises(AppearanceError, msg=str(bad)):
                normalize_appearance(bad)

    def test_layout(self):
        ok = normalize_layout({"seeded": True, "items": {"Music.shc": {"c": 1, "r": 2}}})
        self.assertEqual(ok["items"]["Music.shc"], {"c": 1, "r": 2})
        for bad in ({"items": {"a/b": {"c": 0, "r": 0}}}, {"items": {"a": {"c": -1, "r": 0}}}, {"items": {"a": {"c": 0}}}, {"items": []}):
            with self.assertRaises(AppearanceError):
                normalize_layout(bad)


class FakeDb:
    def __init__(self): self.calls = []
    def execute(self, sql, params=()): self.calls.append((sql, params)); return 1


class FakeServer:
    def __init__(self): self.events = []
    def publish(self, user, topic, payload, exclude_app=None): self.events.append((user, topic, payload))


class DesktopAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root, self.data = os.path.join(self.tmp, "root"), os.path.join(self.tmp, "appdata")
        for d in ("desktop", "documents"):
            os.makedirs(os.path.join(self.root, d))
        os.makedirs(self.data)
        self.server, self.db = FakeServer(), FakeDb()
        self.app = self.make()

    def make(self, db=True):
        ctx = AppContext(user_id=7, username="u", appdata_path=self.data, root_path=self.root,
                         db=self.db if db else None, server=self.server)
        return DesktopApp(ctx)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_parses_shortcuts_and_flags_broken_ones(self):
        self.app.write("shortcut_create", shortcut={"name": "Music", "open": "music"})
        with open(os.path.join(self.root, "desktop", "broken.shc"), "w") as fp:
            fp.write("<shortcut")
        open(os.path.join(self.root, "desktop", "notes.txt"), "w").close()
        snap = self.app.fetch("snapshot")
        by_path = {s["path"]: s for s in snap["shortcuts"]}
        self.assertEqual(by_path["/desktop/Music.shc"]["shortcut"]["open"], "music")
        self.assertEqual(by_path["/desktop/broken.shc"]["error"], "invalid_xml")
        self.assertEqual(len(snap["content"]), 3)
        self.assertFalse(snap["layout"]["seeded"])

    def test_seed_is_idempotent_and_respects_user_deletions(self):
        items = [{"name": "Music", "icon": "music", "open": "music"}, {"name": "Terminal", "icon": "terminal", "open": "terminal"}]
        self.assertEqual(len(self.app.write("shortcuts_seed", items=items)["created"]), 2)
        self.assertTrue(self.app.write("shortcuts_seed", items=items)["skipped"])
        os.remove(os.path.join(self.root, "desktop", "Music.shc"))
        self.assertEqual(self.app.write("shortcuts_seed", items=items)["created"], [])   # seeded once: stays deleted
        self.assertEqual(self.app.write("shortcuts_seed", items=items, force=True)["created"], ["/desktop/Music.shc"])  # explicit restore
        with self.assertRaises(AppError):
            self.app.write("shortcuts_seed", items=[{"name": "x"}], force=True)

    def test_save_validates_and_detects_concurrent_edit(self):
        made = self.app.write("shortcut_create", shortcut={"name": "Docs", "open": "explorer"})
        path = made["path"]
        saved = self.app.write("shortcut_save", path=path, shortcut={"name": "Docs", "open": "explorer", "args": [{"name": "path", "value": "/documents"}]})
        self.assertIn('<arg name="path">/documents</arg>', open(os.path.join(self.root, "desktop", "Docs.shc")).read())
        with self.assertRaises(AppError) as ctx:
            self.app.write("shortcut_save", path=path, shortcut={"name": "Docs", "open": "x"}, base_mtime="0-0-0")
        self.assertEqual(ctx.exception.code, "conflict")
        for bad in ("/desktop/a.txt", "/virtual/x.shc", 5):
            with self.assertRaises(AppError):
                self.app.write("shortcut_save", path=bad, shortcut={"name": "a", "open": "b"})
        with self.assertRaises(AppError):
            self.app.write("shortcut_save", path=path, shortcut={"name": "a", "open": "../../etc"})

    def test_names_are_made_unique_and_safe(self):
        a = self.app.write("shortcut_create", shortcut={"name": "../../evil", "open": "x"})["path"]
        b = self.app.write("shortcut_create", shortcut={"name": "../../evil", "open": "x"})["path"]
        self.assertEqual(os.path.dirname(a), "/desktop")
        self.assertNotEqual(a, b)
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "desktop"))), sorted([os.path.basename(a), os.path.basename(b)]))

    def test_layout_round_trip_and_conflict(self):
        v = self.app.write("layout_save", layout={"items": {"a.shc": {"c": 1, "r": 1}}})["version"]
        self.assertEqual(self.app.fetch("layout")["layout"]["items"]["a.shc"], {"c": 1, "r": 1})
        self.app.write("layout_save", layout={"items": {}}, base_version=v)
        with self.assertRaises(AppError) as ctx:
            self.app.write("layout_save", layout={"items": {}}, base_version=v)
        self.assertEqual(ctx.exception.code, "conflict")
        with self.assertRaises(AppError):
            self.app.write("layout_save", layout={"items": {"../x": {"c": 0, "r": 0}}})

    def test_layout_save_cannot_unset_seeded(self):
        self.app.write("shortcuts_seed", items=[{"name": "M", "open": "m"}])
        self.app.write("layout_save", layout={"seeded": False, "items": {}})
        self.assertTrue(self.app.fetch("layout")["layout"]["seeded"])

    def test_appearance_lives_in_appdata_not_in_the_users_files(self):
        self.app.write("appearance_save", appearance={"desktop": {"mode": "color", "color": "#101010"}}, origin="tab1")
        self.assertTrue(os.path.exists(os.path.join(self.data, "desktop", "appearance.json")))
        self.assertEqual(os.listdir(os.path.join(self.root, "desktop")), [])
        self.assertEqual(self.app.fetch("appearance")["appearance"]["desktop"]["color"], "#101010")
        kind = json.loads(self.db.calls[-1][1][0])
        self.assertEqual((kind["kind"], kind["origin"], kind["user"]), ("appearance", "tab1", 7))
        with self.assertRaises(AppError):
            self.app.write("appearance_save", appearance={"colors": {"--x": "red"}})
        self.app.write("appearance_reset")
        self.assertIsNone(self.app.fetch("appearance")["appearance"])

    def test_corrupt_appdata_falls_back_to_defaults(self):
        os.makedirs(os.path.join(self.data, "desktop"))
        for name in ("appearance.json", "layout.json"):
            with open(os.path.join(self.data, "desktop", name), "w") as fp:
                fp.write("{not json")
        self.assertIsNone(self.app.fetch("appearance")["appearance"])
        self.assertEqual(self.app.fetch("layout")["layout"]["items"], {})

    def test_without_database_events_are_delivered_locally(self):
        app = self.make(db=False)
        app.write("appearance_reset", origin="t")
        self.assertEqual(self.server.events[-1][1:], ("desktop", {"kind": "appearance", "origin": "t"}))
        self.assertEqual(app.on_event("desktop", {"kind": "layout", "origin": "x"})["event"], "desktop_changed")


class VirtualMountGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "documents"))
        self.fs = UserFS(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_virtual_is_reserved_and_read_only(self):
        with self.assertRaises(FsError) as c:
            self.fs.mkdir("/", "virtual")
        self.assertEqual(c.exception.code, "reserved_name")
        self.fs.mkfile("/documents", "a.txt")
        self.fs.mkdir("/documents", "virtual")  # only the top level name is reserved
        for call in (lambda: self.fs.mkfile("/virtual", "x"), lambda: self.fs.write_text("/virtual/x", "1", create=True),
                     lambda: self.fs.delete("/virtual/sh"), lambda: self.fs.copy(["/documents/a.txt"], "/virtual"),
                     lambda: self.fs.chmod("/virtual/sh", True)):
            with self.assertRaises(FsError) as c:
                call()
            self.assertEqual(c.exception.code, "read_only")

    def test_chmod_and_peek(self):
        self.fs.write_text("/documents/run.sh", "#!/virtual/sh\necho hi\n", create=True)
        self.assertFalse(self.fs.stat("/documents/run.sh")["executable"])
        self.fs.chmod("/documents/run.sh", True)
        self.assertTrue(self.fs.stat("/documents/run.sh")["executable"])
        self.assertTrue(self.fs.peek("/documents/run.sh", 2) == b"#!")
        self.fs.chmod("/documents/run.sh", False)
        self.assertFalse(self.fs.stat("/documents/run.sh")["executable"])


if __name__ == "__main__":
    unittest.main()


class DesktopHearsItsOwnChanges(unittest.TestCase):
    def test_the_desktop_session_is_not_excluded_from_fs_events_it_causes(self):
        tmp = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmp, "root", "desktop")); os.makedirs(os.path.join(tmp, "appdata"))
            seen = []

            class Srv:
                def publish(self, user, topic, payload, exclude_app=None): seen.append((topic, exclude_app))
            app = DesktopApp(AppContext(user_id=1, username="u", appdata_path=os.path.join(tmp, "appdata"), root_path=os.path.join(tmp, "root"), db=None, server=Srv()))
            app.write("shortcut_create", shortcut={"name": "A", "open": "x"})
            self.assertEqual(seen, [("fs", None)], "published with no exclusion: the desktop refreshes after its own create")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
