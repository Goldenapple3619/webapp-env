"""The terminal's worker-thread path with the real event fan-out (Server._deliver) and a runner that can be held."""
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from src.network.wsserver import AppContext, AppSession, Server
import apps.terminalApp as terminal_module
from apps.terminalApp import TerminalApp


class SlowRunner:
    enabled = True

    def __init__(self):
        self.started, self.release, self.cancelled, self.requests = threading.Event(), threading.Event(), set(), []

    def tools(self, force=False):
        return {"sandbox": "fake", "tools": [{"name": "python3", "description": "py", "version": "3"}]}

    def run(self, request):
        self.requests.append(request)
        self.started.set()
        self.release.wait(5)
        if request["job"] in self.cancelled:
            return {"status": 130, "cancelled": True, "stdout": "partial\n", "stderr": ""}
        return {"status": 0, "stdout": "done\n", "stderr": ""}

    def cancel(self, job):
        self.cancelled.add(job)
        self.release.set()
        return True


class Client:
    def __init__(self):
        self.started_apps_sessions, self.sent = [], []

    def send_message(self, message):
        self.sent.append(message)

    def events(self, session_id):
        return [m.data for m in self.sent if m.action == f"event_{session_id}"]


class FakeServer:
    def __init__(self, client):
        self.client = client

    def publish(self, user_id, topic, payload, exclude_app=None):
        Server._deliver(self.client, topic, payload, exclude_app)


class FakeDb:
    def __init__(self):
        self.rows = []

    def execute(self, sql, params=()):
        self.rows.append(params)
        return 1


def wait_for(condition, timeout=4):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.01)
    return False


class AsyncTerminal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, "root", "documents"))
        self.runner, self.db, self.client = SlowRunner(), FakeDb(), Client()
        server = FakeServer(self.client)
        patch = mock.patch.object(terminal_module, "shared_runner", return_value=self.runner)
        patch.start()
        self.addCleanup(patch.stop)

        def make(sid):
            ctx = AppContext(user_id=5, username="u", appdata_path=os.path.join(self.tmp.name, "appdata"),
                             root_path=os.path.join(self.tmp.name, "root"), db=self.db, server=server)
            app = TerminalApp(ctx)
            session = AppSession(sid, app)
            self.client.started_apps_sessions.append(session)
            return app

        self.a, self.b = make("A"), make("B")
        self.fs_listener = type("L", (), {"topics": ("fs",), "closed": False, "events": [],
                                          "on_event": lambda s, t, p: s.events.append(p)})()
        self.client.started_apps_sessions.append(type("S", (), {"app": self.fs_listener, "session_id": "F"})())

    def tearDown(self):
        self.runner.release.set()
        self.tmp.cleanup()

    def test_builtins_stay_synchronous(self):
        out = self.a.write("exec", line="echo hi")
        self.assertEqual((out["output"], out["status"]), ("hi\n", 0))
        self.assertNotIn("pending", out)

    def test_a_program_answers_pending_then_one_event_to_the_right_terminal_only(self):
        reply = self.a.write("exec", line="python3 slow.py")
        self.assertIn("pending", reply)
        self.assertTrue(self.runner.started.wait(2))
        self.assertEqual(self.client.events("A"), [], "nothing until it finishes")
        self.assertEqual(self.a.fetch("prompt")["running"], True)
        with self.assertRaises(Exception) as ctx:   # a second line while one runs
            self.a.write("exec", line="python3 again.py")
        self.assertEqual(ctx.exception.code, "busy")
        self.assertEqual(self.b.write("exec", line="echo other terminal still works")["status"], 0, "builtins of OTHER terminals are untouched")
        self.runner.release.set()
        self.assertTrue(wait_for(lambda: self.client.events("A")))
        event = self.client.events("A")[0]
        self.assertEqual((event["event"], event["job"], event["output"], event["status"]), ("exec_done", reply["pending"], "done\n", 0))
        self.assertEqual(self.client.events("B"), [], "terminal B must not see A's result")
        self.assertIsNone(self.a.job)
        self.assertTrue(any(e.get("resync") for e in self.fs_listener.events), "files may have changed: explorers refresh")
        self.assertEqual(self.db.rows[-1][1], "python3")  # audit row: user, tool, ...
        self.assertEqual(self.a.write("exec", line="echo next")["output"], "next\n", "ready for the next line immediately")

    def test_kill_cancels_the_program_through_the_runner(self):
        self.a.write("exec", line="python3 forever.py")
        self.assertTrue(self.runner.started.wait(2))
        self.assertTrue(self.a.write("kill")["killed"])
        self.assertTrue(wait_for(lambda: self.client.events("A")))
        event = self.client.events("A")[0]
        self.assertEqual(event["status"], 130)
        self.assertIn("interrupted", event["output"])
        self.assertEqual(self.runner.requests[0]["job"] in self.runner.cancelled, True)
        self.assertFalse(self.a.write("kill")["killed"], "nothing left to kill")

    def test_closing_the_window_stops_the_program(self):
        self.a.write("exec", line="python3 forever.py")
        self.assertTrue(self.runner.started.wait(2))
        self.a.close()
        self.assertTrue(wait_for(lambda: self.runner.cancelled))
        time.sleep(0.2)
        self.assertEqual(self.client.events("A"), [], "a closed terminal receives nothing")

    def test_per_user_limit(self):
        with mock.patch.object(terminal_module.Config, "exec_per_user", 1):
            self.a.write("exec", line="python3 one.py")
            self.assertTrue(self.runner.started.wait(2))
            with self.assertRaises(Exception) as ctx:
                self.b.write("exec", line="python3 two.py")
            self.assertEqual(ctx.exception.code, "busy")
            self.assertIn("at most 1", str(ctx.exception))
        self.runner.release.set()

    def test_set_cwd_does_not_pollute_history_and_tools_listing(self):
        self.a.write("set_cwd", path="/documents")
        self.assertEqual(self.a.shell.cwd, "/documents")
        self.assertEqual(self.a.shell.history, [])
        self.a.write("set_cwd", path="/nowhere")
        self.assertEqual(self.a.shell.cwd, "/documents")
        tools = self.a.fetch("tools")
        self.assertEqual((tools["enabled"], tools["tools"][0]["name"]), (True, "python3"))


if __name__ == "__main__":
    unittest.main()
