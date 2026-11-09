"""
End-to-end test of the gateway against a RUNNING stack (api + gateway + postgres).

    API_URL=http://127.0.0.1:8000/api WS_URL=ws://127.0.0.1:8001 python -m unittest tests.test_e2e -v

It creates a throw-away account, so it is safe to run against a dev database.
"""
import json
import os
import unittest
import urllib.request
import uuid

from websockets.sync.client import connect

API = os.environ.get("API_URL", "http://127.0.0.1:8000/api")
WS = os.environ.get("WS_URL", "ws://127.0.0.1:8001")


def http(method, path, body=None, token=None, raw=None):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(API + path, method=method, headers=headers,
                                 data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None))
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


class Conn:
    """Tiny blocking websocket client with request/response correlation by `rid`."""

    def __init__(self):
        self._cm = connect(WS)
        self.ws = self._cm.__enter__()
        self.n = 0
        self.events = []

    def send(self, action, data=None):
        self.n += 1
        self.ws.send(json.dumps({"action": action, "data": data or {}, "rid": self.n}))
        return self.n

    def recv(self, timeout=5):
        return json.loads(self.ws.recv(timeout=timeout))

    def call(self, action, data=None):
        rid = self.send(action, data)
        while True:
            msg = self.recv()
            if msg.get("rid") == rid:
                return msg
            self.events.append(msg)

    def wait_event(self, predicate, timeout=5):
        for i, ev in enumerate(self.events):
            if predicate(ev):
                return self.events.pop(i)
        while True:
            ev = self.recv(timeout)
            if predicate(ev):
                return ev
            self.events.append(ev)

    def app(self, name):
        msg = self.call("start_app", {"name": name, "identifier": "x"})
        assert msg["data"]["message"] == "start_done", msg
        return msg["data"]["session_id"]

    def fetch(self, sid, kind, **query):
        return self.call("fetch_app", {"app_session": sid, "fetch_type": kind, "query": query})["data"]

    def update(self, sid, kind, **query):
        return self.call("update_app", {"app_session": sid, "update_type": kind, "query": query})["data"]

    def close(self):
        self._cm.__exit__(None, None, None)


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "e2e_" + uuid.uuid4().hex[:8]
        status, body = http("POST", "/auth/register", {"username": cls.name, "password": "e2e-password-1"})
        assert status == 201, body
        cls.token, cls.sid = body["accessToken"], body["sessionId"]

    def conn(self, login=True):
        c = Conn()
        self.addCleanup(c.close)
        if login:
            msg = c.call("connect", {"token": self.token})
            self.assertEqual(msg["data"]["message"], "ok", msg)
        return c

    # ---- authentication ----------------------------------------------------------------------------
    def test_auth_required_and_bad_tokens(self):
        c = self.conn(login=False)
        self.assertEqual(c.call("start_app", {"name": "explorer"})["data"]["message"], "not_loggedin")
        self.assertEqual(c.call("connect", {"token": "garbage"})["data"]["reason"], "invalid_token")
        self.assertEqual(c.call("connect", {})["data"]["reason"], "missing_token")

    def test_survives_garbage_and_unknown_actions(self):
        c = self.conn()
        c.ws.send("{not json")
        self.assertEqual(c.recv()["action"], "invalid_message")
        c.ws.send(json.dumps([1, 2]))
        self.assertEqual(c.recv()["action"], "invalid_message")
        self.assertEqual(c.call("nope")["action"], "invalid_action")
        self.assertEqual(c.call("ping")["action"], "pong")  # still alive

    def test_renew_token_on_open_socket(self):
        c = self.conn()
        status, body = http("POST", "/auth/login", {"username": self.name, "password": "e2e-password-1"})
        msg = c.call("connect", {"token": body["accessToken"]})  # different session -> new identity
        self.assertEqual(msg["data"]["message"], "ok")

    def test_revoking_session_kicks_socket_immediately(self):
        status, body = http("POST", "/auth/login", {"username": self.name, "password": "e2e-password-1"})
        c = Conn()
        self.addCleanup(c.close)
        self.assertEqual(c.call("connect", {"token": body["accessToken"]})["data"]["message"], "ok")
        http("DELETE", f"/auth/sessions/{body['sessionId']}", token=self.token)
        ended = c.wait_event(lambda m: m["action"] == "session_ended")
        self.assertEqual(ended["data"]["message"], "session_revoked")

    # ---- explorer -------------------------------------------------------------------------------------
    def test_explorer_file_operations(self):
        c = self.conn()
        s = c.app("explorer")
        root = c.fetch(s, "listdir", path="/")["value"]
        self.assertEqual([e["name"] for e in root["content"]][:3], ["desktop", "documents", "downloads"])

        self.assertEqual(c.update(s, "mkdir", path="/documents", name="proj")["value"]["path"], "/documents/proj")
        self.assertEqual(c.update(s, "mkdir", path="/documents", name="proj")["error"], "exists")
        self.assertEqual(c.update(s, "mkfile", path="/documents/proj", name="a.txt")["message"], "update_done")
        self.assertEqual(c.update(s, "rename", path="/documents/proj/a.txt", name="zq.txt")["value"]["path"], "/documents/proj/zq.txt")
        self.assertEqual(c.update(s, "copy", paths=["/documents/proj/zq.txt"], dest="/documents/proj")["value"]["paths"], ["/documents/proj/zq (copy).txt"])
        self.assertEqual(c.update(s, "move", paths=["/documents/proj"], dest="/desktop")["value"]["paths"], ["/desktop/proj"])
        found = c.fetch(s, "search", path="/", query="zq")["value"]["content"]
        self.assertEqual(sorted(e["path"] for e in found), ["/desktop/proj/zq (copy).txt", "/desktop/proj/zq.txt"])
        self.assertEqual(c.update(s, "delete", paths=["/desktop/proj"])["message"], "update_done")
        self.assertEqual(c.fetch(s, "stat", path="/desktop/proj")["error"], "not_found")

    def test_explorer_safety(self):
        c = self.conn()
        s = c.app("explorer")
        for evil in ("../../..", "/../../etc", "..\\..\\..\\etc", "/documents/../../.."):
            r = c.fetch(s, "listdir", path=evil)
            # clamped inside the user's own root: either that root's listing or "not found",
            # never anything from the host (/etc would contain "passwd", the user root never does)
            if r["message"] == "fetch_done":
                self.assertNotIn("passwd", [e["name"] for e in r["value"]["content"]], evil)
            else:
                self.assertEqual(r["error"], "not_found", (evil, r))
        self.assertEqual(c.fetch(s, "stat", path="/etc/passwd")["error"], "not_found")
        self.assertEqual(c.update(s, "delete", paths=["/documents"])["error"], "forbidden")
        self.assertEqual(c.update(s, "delete", paths=["/"])["error"], "forbidden")
        self.assertEqual(c.update(s, "rename", path="/music", name="x")["error"], "forbidden")
        self.assertEqual(c.update(s, "mkdir", path="/", name="a/b")["error"], "invalid_name")
        self.assertEqual(c.update(s, "mkdir", path="/", name="..")["error"], "invalid_name")
        self.assertEqual(c.fetch(s, "listdir", path="/documents", **{"fetch_type": "x"})["error"], "bad_query")

    def test_live_events_between_sessions_and_http_upload(self):
        a, b = self.conn(), self.conn()
        sa, sb = a.app("explorer"), b.app("explorer")
        a.update(sa, "mkdir", path="/documents", name="live_" + uuid.uuid4().hex[:4])
        ev = b.wait_event(lambda m: m["action"] == f"event_{sb}")
        self.assertEqual(ev["data"]["event"], "fs_changed")
        self.assertIn("/documents", ev["data"]["dirs"])
        # the session that made the change does not get an echo of its own write
        self.assertFalse([m for m in a.events if m["action"] == f"event_{sa}"])

        status, _ = http("PUT", "/my/documents/up.txt", token=self.token, raw=b"hello")
        self.assertEqual(status, 201)
        ev = b.wait_event(lambda m: m["action"] == f"event_{sb}" and m["data"].get("op") == "upload")
        self.assertEqual(ev["data"]["files"], ["/documents/up.txt"])

    # ---- code editor ----------------------------------------------------------------------------------
    def test_code_editor_read_save_conflict_lint(self):
        c = self.conn()
        s = c.app("codeEditor")
        saved = c.update(s, "save", path="/documents/t.py", content="print('hi')\n", create=True)["value"]
        self.assertTrue(saved["created"])
        read = c.fetch(s, "read", path="/documents/t.py")["value"]
        self.assertEqual((read["content"], read["eol"], read["mtime"]), ("print('hi')\n", "lf", saved["mtime"]))

        ok = c.update(s, "save", path="/documents/t.py", content="x = 1\n", base_mtime=read["mtime"])
        self.assertEqual(ok["message"], "update_done")
        stale = c.update(s, "save", path="/documents/t.py", content="x = 2\n", base_mtime=read["mtime"])
        self.assertEqual(stale["error"], "conflict")
        forced = c.update(s, "save", path="/documents/t.py", content="x = 2\n", base_mtime=read["mtime"], force=True)
        self.assertEqual(forced["message"], "update_done")

        bad = c.fetch(s, "lint", language="python", content="def (:\n")["value"]["problems"]
        self.assertEqual(bad[0]["severity"], "error")
        self.assertEqual(c.fetch(s, "lint", language="json", content='{"a": 1}')["value"]["problems"], [])
        self.assertEqual(c.fetch(s, "lint", language="json", content='{"a": }')["value"]["problems"][0]["line"], 1)

        c.update(s, "save", path="/documents/win.txt", content="a\nb\n", eol="crlf", create=True)
        self.assertEqual(c.fetch(s, "read", path="/documents/win.txt")["value"]["eol"], "crlf")
        self.assertEqual(c.update(s, "save", path="/documents/nope/x.txt", content="x", create=True)["error"], "not_found")

        self.assertEqual(c.update(s, "state", state={"tabs": ["/documents/t.py"]})["message"], "update_done")
        self.assertEqual(c.fetch(s, "state")["value"]["state"], {"tabs": ["/documents/t.py"]})

    def test_code_editor_refuses_binary_and_huge(self):
        c = self.conn()
        s = c.app("codeEditor")
        http("PUT", "/my/documents/bin.dat", token=self.token, raw=b"\x00\x01\x02binary")
        self.assertEqual(c.fetch(s, "read", path="/documents/bin.dat")["error"], "binary")
        http("PUT", "/my/documents/huge.txt", token=self.token, raw=b"a" * (3 * 1024 * 1024))
        self.assertEqual(c.fetch(s, "read", path="/documents/huge.txt")["error"], "too_large")

    # ---- music ---------------------------------------------------------------------------------------
    def test_music_playlists(self):
        c = self.conn()
        for n in ("one.mp3", "two.ogg", "cover.jpg"):
            http("PUT", f"/my/music/{n}?overwrite=1", token=self.token, raw=b"fake-audio-bytes")
        s = c.app("music")

        lib = c.fetch(s, "library")["value"]["content"]
        self.assertEqual(sorted(x["path"] for x in lib), ["/music/one.mp3", "/music/two.ogg"])
        self.assertEqual(lib[0]["cover"], "/music/cover.jpg")

        pl = c.update(s, "playlists_create", name="Road trip")["value"]
        self.assertEqual(c.update(s, "playlists_create", name="Road trip")["error"], "exists")
        self.assertEqual(c.update(s, "playlists_create", name="  ")["error"], "invalid_name")
        add = c.update(s, "song_add", playlist=pl["id"], paths=["/music/one.mp3", "/music/two.ogg"])
        self.assertEqual(add["value"]["added"], 2)
        self.assertEqual(c.update(s, "song_add", playlist=pl["id"], paths=["/music/cover.jpg"])["error"], "not_audio")
        self.assertEqual(c.update(s, "song_add", playlist=pl["id"], paths=["/../../etc/passwd"])["error"], "not_audio")

        songs = c.fetch(s, "playlists")["value"]["content"][0]["songs"]
        self.assertEqual([x["name"] for x in songs], ["one", "two"])
        c.update(s, "song_move", playlist=pl["id"], id=songs[1]["id"], position=0)
        songs = c.fetch(s, "playlists")["value"]["content"][0]["songs"]
        self.assertEqual([x["name"] for x in songs], ["two", "one"])
        c.update(s, "song_delete", playlist=pl["id"], id=songs[0]["id"])
        self.assertEqual(len(c.fetch(s, "playlists")["value"]["content"][0]["songs"]), 1)
        self.assertEqual(c.update(s, "playlists_rename", id=pl["id"], name="Trip")["value"]["name"], "Trip")
        self.assertEqual(c.update(s, "playlists_delete", id=pl["id"])["message"], "update_done")
        self.assertEqual(c.fetch(s, "playlists")["value"]["content"], [])
        self.assertEqual(len(c.fetch(s, "library")["value"]["content"]), 2)  # deleting a playlist never deletes music

    def test_playlists_are_private_per_user(self):
        c = self.conn()
        s = c.app("music")
        pl = c.update(s, "playlists_create", name="mine")["value"]
        other = "e2e_" + uuid.uuid4().hex[:8]
        _, body = http("POST", "/auth/register", {"username": other, "password": "e2e-password-2"})
        o = Conn()
        self.addCleanup(o.close)
        o.call("connect", {"token": body["accessToken"]})
        os_ = o.app("music")
        self.assertEqual(o.update(os_, "playlists_delete", id=pl["id"])["error"], "not_found")
        self.assertEqual(o.update(os_, "song_add", playlist=pl["id"], paths=["/x.mp3"])["error"], "not_found")
        self.assertEqual(o.fetch(os_, "playlists")["value"]["content"], [])

    # ---- terminal ------------------------------------------------------------------------------------
    def test_terminal(self):
        c = self.conn()
        s = c.app("terminalEmulator")

        def run(line):
            return c.update(s, "exec", line=line)["value"]

        self.assertEqual(run("pwd")["output"], "/\n")
        self.assertEqual(run("cd documents && pwd")["output"], "/documents\n")
        run("echo hello world > note.txt")
        run("echo second >> note.txt")
        self.assertEqual(run("cat note.txt")["output"], "hello world\nsecond\n")
        self.assertEqual(run("cat note.txt | grep -i SEC | wc -l")["output"], "1\n")
        self.assertIn("note.txt", run("ls")["output"])
        self.assertEqual(run("cd /../../etc")["cwd"], "/documents")  # cannot leave the sandbox
        self.assertEqual(run("cat /etc/passwd")["status"], 1)
        self.assertEqual(run("rm -r /documents")["status"], 1)  # protected
        self.assertEqual(run("nosuchcmd")["status"], 127)
        self.assertEqual(run("python -c 'import os'")["status"], 127)  # no real processes, ever
        self.assertEqual(run("open note.txt")["actions"][0]["path"], "/documents/note.txt")
        self.assertTrue(run("clear")["clear"])
        self.assertIn("note.txt", c.fetch(s, "complete", line="cat no")["value"]["matches"])
        self.assertTrue(run("echo a; echo b")["output"] == "a\nb\n")
        self.assertEqual(run("false_cmd && echo no")["output"].count("no"), 1)  # only the error text


if __name__ == "__main__":
    unittest.main()
