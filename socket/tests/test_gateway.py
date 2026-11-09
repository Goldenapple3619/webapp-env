"""
Behaviour of the gateway's network layer, with real sockets and a real Server (no database needed, except where a
test says so). Run:  python3 -m unittest tests.test_gateway
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import warnings
from http import HTTPStatus
from pathlib import Path

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect
from websockets.sync.server import serve

warnings.filterwarnings("ignore", category=DeprecationWarning)  # websockets' sync client wants `with connect(...)`
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.network import wsserver  # noqa: E402
from src.network.origins import origin_allowed  # noqa: E402
from src.network.wsserver import MessageJSON, ProtocolError, Server  # noqa: E402


class Gateway:
    """A Server on an ephemeral port with a trivial `ping` route, for tests to poke at."""

    def __init__(self, **options):
        self.server = Server(lambda handler: serve(handler, "127.0.0.1", 0, max_size=1024 * 1024, ping_interval=None, close_timeout=1), **options)
        self.server.add_route("ping", lambda server, client, message: client.send_message(MessageJSON("pong", {}, rid=message.rid)))
        self.port = self.server.websocket.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve, daemon=True)
        self.thread.start()
        self.url = f"ws://127.0.0.1:{self.port}"

    def wait_for_clients(self, count, timeout=3):
        end = time.time() + timeout
        while time.time() < end:
            if len(self.server.clients) >= count:
                return list(self.server.clients.values())
            time.sleep(0.01)
        raise AssertionError(f"expected {count} clients, have {len(self.server.clients)}")

    def stop(self):
        self.server._closing = True
        self.server.websocket.shutdown()


def login(server, client, user_id=1, session="s"):
    client.login, client.id, client.session_id, client.token_exp = True, user_id, session, time.time() + 600
    server.bind_user(client)


def close_code(ws, timeout=3):
    """Reads until the connection ends and returns the close code the server sent."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            ws.recv(timeout=0.5)
        except TimeoutError:
            continue
        except ConnectionClosed as exc:
            return exc.rcvd.code if exc.rcvd else None
    raise AssertionError("connection was not closed")


class OutboxTests(unittest.TestCase):
    def test_a_slow_consumer_never_blocks_the_sender_nor_other_users(self):
        gw = Gateway(outbox_size=32)
        self.addCleanup(gw.stop)

        slow_sock = socket.socket()
        slow_sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
        slow_sock.connect(("127.0.0.1", gw.port))
        slow = connect(gw.url, sock=slow_sock)  # a websocket that we simply never read from
        fast = connect(gw.url)
        self.addCleanup(fast.close)
        clients = gw.wait_for_clients(2)
        slow_client = next(c for c in clients if c.socket.remote_address[1] == slow_sock.getsockname()[1])
        fast_client = next(c for c in clients if c is not slow_client)
        login(gw.server, slow_client, 1, "slow")
        login(gw.server, fast_client, 2, "fast")

        # Fan out like the pg listener does: one thread, one message after another, first to the slow user.
        # With a blocking send this loop would hang as soon as the slow socket's buffers fill up.
        blob = "x" * 60_000
        started = time.time()
        for i in range(400):
            slow_client.send_message(MessageJSON("event", {"i": i, "pad": blob}))
        fast_client.send_message(MessageJSON("event", {"marker": True}))
        self.assertLess(time.time() - started, 2.0, "the sender was held up by a client that does not read")

        message = json.loads(fast.recv(timeout=3))
        self.assertTrue(message["data"]["marker"], "another user must still receive its event")
        deadline = time.time() + 5
        while not slow_client.closed and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(slow_client.closed, "the slow browser must be disconnected, not waited for")
        slow_sock.close()

    def test_order_is_preserved_and_close_flushes_what_was_queued(self):
        gw = Gateway()
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        client = gw.wait_for_clients(1)[0]
        for i in range(50):
            client.send_message(MessageJSON("n", {"i": i}))
        client.send_message(MessageJSON("session_ended", {"message": "bye"}, code=401))
        client.close_async(4401, "bye")

        seen = []
        with self.assertRaises(ConnectionClosed) as ctx:
            while True:
                seen.append(json.loads(ws.recv(timeout=3)))
        self.assertEqual([m["data"].get("i") for m in seen[:50]], list(range(50)))
        self.assertEqual(seen[50]["action"], "session_ended")
        self.assertEqual(ctx.exception.rcvd.code, 4401)


class AdmissionTests(unittest.TestCase):
    def test_a_socket_that_never_authenticates_is_dropped(self):
        gw = Gateway()
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        gw.wait_for_clients(1)
        time.sleep(0.3)
        gw.server.sweep_unauthenticated(0.1)
        self.assertEqual(close_code(ws), 4401)

    def test_an_authenticated_socket_survives_the_sweep(self):
        gw = Gateway()
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        login(gw.server, gw.wait_for_clients(1)[0])
        time.sleep(0.3)
        gw.server.sweep_unauthenticated(0.1)
        ws.send(json.dumps({"action": "ping", "rid": 7}))
        self.assertEqual(json.loads(ws.recv(timeout=2))["rid"], 7)

    def test_big_messages_are_refused_before_anyone_logs_in(self):
        gw = Gateway(pre_auth_max_bytes=1024)
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        ws.send(json.dumps({"action": "ping", "data": {"pad": "x" * 5000}}))
        self.assertEqual(close_code(ws), 1009)

    def test_there_is_a_cap_on_sockets_that_have_not_authenticated(self):
        gw = Gateway(max_unauthenticated=3)
        self.addCleanup(gw.stop)
        first = [connect(gw.url) for _ in range(3)]
        gw.wait_for_clients(3)
        extra = connect(gw.url)
        self.assertEqual(close_code(extra), 1013)
        for ws in first:
            ws.close()

    def test_rate_limiting_happens_before_parsing(self):
        parsed = []
        original = MessageJSON.from_raw.__func__

        def counting(cls, raw):
            parsed.append(1)
            return original(cls, raw)

        MessageJSON.from_raw = classmethod(counting)
        self.addCleanup(lambda: setattr(MessageJSON, "from_raw", classmethod(original)))

        # the pre-auth size limit is raised out of the way: this test is about the ORDER of rate limiting and parsing
        gw = Gateway(burst=5, rate=1, rate_strikes=10_000, pre_auth_max_bytes=10_000_000)
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        blob = json.dumps({"action": "ping", "data": {"pad": [0] * 30_000}})  # ~60 KB: not worth parsing when refused
        for _ in range(100):
            ws.send(blob)
        time.sleep(0.8)
        self.assertGreater(gw.server.clients and 1, 0, "the connection must still be open for this test to mean anything")
        self.assertLessEqual(len(parsed), 7, f"{len(parsed)} of 100 flooded messages were parsed")

    def test_a_refusal_still_carries_the_rid_of_a_small_request(self):
        gw = Gateway(burst=1, rate=1, rate_strikes=10_000)
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        for rid in range(1, 6):
            ws.send(json.dumps({"action": "ping", "rid": rid}))
        replies = [json.loads(ws.recv(timeout=2)) for _ in range(5)]
        limited = [r for r in replies if r["action"] == "rate_limited"]
        self.assertTrue(limited)
        self.assertTrue(all(r["rid"] is not None for r in limited), "the client matches replies to requests by rid")

    def test_a_client_that_ignores_the_rate_limit_is_disconnected(self):
        gw = Gateway(burst=2, rate=1, rate_strikes=10)
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        for _ in range(60):
            try:
                ws.send(json.dumps({"action": "ping"}))
            except ConnectionClosed:
                break
        self.assertEqual(close_code(ws), 1008)


class RegistryTests(unittest.TestCase):
    def test_at_the_limit_the_oldest_socket_is_replaced_instead_of_locking_the_user_out(self):
        gw = Gateway(max_per_user=2)
        self.addCleanup(gw.stop)
        sockets = []
        for _ in range(3):
            sockets.append(connect(gw.url))
            client = gw.wait_for_clients(len(sockets))[-1]
            login(gw.server, client, user_id=5, session=f"s{len(sockets)}")
            time.sleep(0.02)

        self.assertEqual(close_code(sockets[0]), wsserver.CLOSE_REPLACED)
        self.assertEqual(len(gw.server.clients_of(5)), 2)
        sockets[2].send(json.dumps({"action": "ping", "rid": 1}))
        self.assertEqual(json.loads(sockets[2].recv(timeout=2))["action"], "pong", "the newest socket works")


class ProtocolTests(unittest.TestCase):
    def test_messages_are_validated(self):
        for raw in [b"\x00\x01", "not json", "[]", '{"action": 5}', '{"action": "Bad Name"}', '{"action": "x", "data": []}',
                    '{"action": "x", "rid": {"a": 1}}', '{"action": "x", "code": "abc"}', "[" * 100_000]:
            with self.assertRaises(ProtocolError, msg=repr(raw)[:40]):
                MessageJSON.from_raw(raw)
        ok = MessageJSON.from_raw('{"action": "fetch_app", "data": {"a": 1}, "rid": 3}')
        self.assertEqual((ok.action, ok.data, ok.rid), ("fetch_app", {"a": 1}, 3))

    def test_a_bad_message_does_not_kill_the_connection(self):
        gw = Gateway()
        self.addCleanup(gw.stop)
        ws = connect(gw.url)
        ws.send("{{{")
        self.assertEqual(json.loads(ws.recv(timeout=2))["action"], "invalid_message")
        ws.send(json.dumps({"action": "ping", "rid": 1}))
        self.assertEqual(json.loads(ws.recv(timeout=2))["action"], "pong")


class OriginTests(unittest.TestCase):
    def test_policy(self):
        listed = ["https://app.example.com"]
        self.assertTrue(origin_allowed("https://anything.example", "ws.example", []), "nothing configured: any origin (token auth)")
        self.assertTrue(origin_allowed(None, "ws.example", listed), "non-browser clients send no Origin")
        self.assertTrue(origin_allowed("https://app.example.com", "ws.example", listed), "listed")
        self.assertTrue(origin_allowed("https://ws.example", "ws.example", listed), "the gateway's own site")
        self.assertFalse(origin_allowed("https://evil.example", "ws.example", listed))
        self.assertFalse(origin_allowed("null", "ws.example", listed))
        self.assertFalse(origin_allowed("https://ws.example.evil.com", "ws.example", listed), "no prefix tricks")


class ConfigTests(unittest.TestCase):
    def run_config(self, **env):
        base = {"PATH": os.environ["PATH"], "JWT_SECRET": "j" * 40, "POSTGRES_DB": "d", "POSTGRES_USER": "u", "POSTGRES_PASSWORD": "p"}
        code = "from src.config import Config\ntry:\n    Config.validate(); print('OK', Config.allowed_origins)\nexcept Exception as e:\n    print(e)"
        return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env={**base, **env}, capture_output=True, text=True).stdout

    def test_junk_is_reported_not_swallowed(self):
        out = self.run_config(WS_AUTH_TIMEOUT_SECONDS="10s", WS_OUTBOX_SIZE="2", DB_PORT="x", CORS_ORIGINS="nope")
        for expected in ("WS_AUTH_TIMEOUT_SECONDS must be an integer", "WS_OUTBOX_SIZE must be an integer", "DB_PORT must be an integer", "nope"):
            self.assertIn(expected, out)

    def test_one_origin_list_for_the_whole_stack(self):
        out = self.run_config(PUBLIC_URL="https://site.example/x", CORS_ORIGINS="https://a.example/, https://site.example", WS_ALLOWED_ORIGINS="https://b.example")
        self.assertIn("['https://site.example', 'https://a.example', 'https://b.example']", out)


class HealthTests(unittest.TestCase):
    def test_healthz_reflects_the_database(self):
        import main

        class Conn:
            def respond(self, status, body):
                return (status, body)

        class Req:
            path, headers = "/healthz", {}

        class Db:
            def __init__(self, up):
                self.up = up

            def ping(self):
                return self.up

        self.assertEqual(main.make_process_request(Db(True))(Conn(), Req())[0], HTTPStatus.OK)
        self.assertEqual(main.make_process_request(Db(False))(Conn(), Req())[0], HTTPStatus.SERVICE_UNAVAILABLE)


class ResyncTests(unittest.TestCase):
    def test_apps_turn_a_resync_into_a_full_reload(self):
        from src.common.fsapp import FsApp

        app = FsApp.__new__(FsApp)
        self.assertEqual(FsApp.on_event(app, "fs", {"resync": True, "dirs": [], "files": []}), {"event": "restore"})
        self.assertEqual(FsApp.on_event(app, "fs", {"op": "upload", "dirs": ["/a"], "files": []})["event"], "fs_changed")


if __name__ == "__main__":
    unittest.main()
