from websockets.exceptions import ConnectionClosed
from websockets.sync.server import WebSocketServer, ServerConnection

import logging
import queue
import re
from json import dumps, loads
from signal import signal, SIGINT, SIGTERM
from threading import Lock, Thread, current_thread
from time import monotonic, time
from traceback import format_exc

log = logging.getLogger("gateway")

ACTION_FORMAT = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
CLOSE_UNAUTHORIZED = 4401
CLOSE_REPLACED = 4409


class ProtocolError(ValueError):
    """The peer sent something that is not a valid message."""


class MessageJSON(object):
    """Wire format: {"action": str, "data": object, "code": int, "rid"?: any}. `rid` is echoed back."""

    def __init__(self, action="unknown", data=None, code=0, rid=None):
        self.action = action
        self.data = {} if data is None else data
        self.code = code
        self.rid = rid

    @classmethod
    def from_raw(cls, raw):
        if not isinstance(raw, str):
            raise ProtocolError("binary_not_supported")
        try:
            parsed = loads(raw)
        except (ValueError, RecursionError):
            raise ProtocolError("invalid_json")
        if not isinstance(parsed, dict):
            raise ProtocolError("invalid_message")
        action = parsed.get("action", "unknown")
        if not isinstance(action, str) or not ACTION_FORMAT.match(action):
            raise ProtocolError("invalid_action")
        data = parsed.get("data", {})
        if not isinstance(data, dict):
            raise ProtocolError("invalid_data")
        rid = parsed.get("rid")
        if rid is not None and not isinstance(rid, (int, str)):
            raise ProtocolError("invalid_rid")
        try:
            code = int(parsed.get("code", 0) or 0)
        except (TypeError, ValueError):
            raise ProtocolError("invalid_code")
        return cls(action, data, code, rid)

    def to_raw(self):
        payload = {"action": self.action, "data": self.data, "code": self.code}
        if self.rid is not None:
            payload["rid"] = self.rid
        return dumps(payload)


class AppError(Exception):
    """Raised by apps for an expected failure; becomes {message: '<kind>_ko', error: code}."""

    def __init__(self, code: str, message: str = "", **details):
        super().__init__(message or code)
        self.code = code
        self.details = details


class AppContext(object):
    """What an app is allowed to know about its owner, plus the event bus."""

    def __init__(self, *, user_id, username, appdata_path, root_path, db, server):
        self.user_id = user_id
        self.username = username
        self.appdata_path = appdata_path
        self.root_path = root_path
        self.db = db
        self.server = server

    def publish(self, topic: str, payload: dict, source=None):
        """Send an event to every app session of this user subscribed to `topic`."""
        if self.server is not None:
            self.server.publish(self.user_id, topic, payload, exclude_app=source)

class App(object):
    topics: tuple = ()

    def __init__(self, ctx_or_path):
        if isinstance(ctx_or_path, AppContext):
            self.ctx = ctx_or_path
            self.path = ctx_or_path.appdata_path
        else:  # legacy: App(appdata_path)
            self.ctx = None
            self.path = ctx_or_path
        self.closed = False

    def load(self):
        pass

    def fetch(self, *args, **kwargs):
        pass

    def write(self, *args, **kwargs):
        pass

    def on_event(self, topic: str, payload: dict):
        return None

    def join_path(self, *path) -> str:
        path = "/".join(map(lambda x: x.strip("/").strip("\\"), path))
        return (self.path.rstrip("/").rstrip("\\") + "/" + str(path)).replace("\\", "/")

    def save(self):
        pass

    def close(self):
        self.closed = True


class AppSession(object):
    def __init__(self, session_id: str, app_class: App):
        self.session_id: str = session_id
        self.app: App = app_class
        self.app.load()

    def read(self, *args, **kwargs):
        if self.app.closed:
            return None
        return self.app.fetch(*args, **kwargs)

    def write(self, *args, **kwargs):
        if self.app.closed:
            return None
        return self.app.write(*args, **kwargs)

    def save(self):
        self.app.save()

    def close(self):
        if self.app.closed:
            return
        try:
            self.save()
        finally:
            self.app.close()
            self.session_id = None


class _Bucket(object):
    def __init__(self, burst: int, rate: int):
        self.burst, self.rate, self.tokens, self.stamp = burst, rate, float(burst), monotonic()

    def allow(self) -> bool:
        now = monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.stamp) * self.rate)
        self.stamp = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

def cheap_rid(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        return None
    try:
        rid = loads(raw).get("rid")
    except (ValueError, AttributeError, RecursionError):
        return None
    return rid if isinstance(rid, (int, str)) else None


class Client(object):
    def __init__(self, socket, *, login=False, user_id=-1, burst=80, rate=40, outbox_size=256):
        self.socket = socket
        self.login = login
        self.id = user_id
        self.username = None
        self.session_id = None
        self.token_exp = 0.0
        self.apps: dict = {}
        self.bucket = _Bucket(burst, rate)
        self.strikes = 0
        self.connected_at = monotonic()
        self.closed = False

        self._app_lock = Lock()
        self._state_lock = Lock()
        self._dead = False
        self._outbox = queue.Queue(maxsize=outbox_size)
        self._writer = Thread(target=self._write_loop, name="ws-writer", daemon=True)
        self._writer.start()

    @property
    def started_apps_sessions(self) -> list:
        with self._app_lock:
            return list(self.apps.values())

    def add_app(self, session: AppSession):
        with self._app_lock:
            self.apps[session.session_id] = session

    def get_app(self, session_id) -> AppSession:
        with self._app_lock:
            return self.apps.get(session_id)

    def close_app(self, session_id):
        with self._app_lock:
            session = self.apps.pop(session_id, None)
        if session:
            session.close()

    def close_all_apps(self):
        with self._app_lock:
            sessions, self.apps = list(self.apps.values()), {}
        for item in sessions:
            try:
                item.close()
            except Exception:
                log.exception("app close failed")

    def send_message(self, message: MessageJSON) -> bool:
        if self.closed or self._dead:
            return False
        try:
            self._outbox.put_nowait(message.to_raw())
            return True
        except queue.Full:
            log.warning("dropping slow client (user %s, %s queued messages)", self.id, self._outbox.qsize())
            self.close_async(1013, "slow_consumer")
            return False

    def _write_loop(self):
        while True:
            try:
                raw = self._outbox.get(timeout=0.2)
            except queue.Empty:
                if self.closed or self._dead:
                    return
                continue
            try:
                self.socket.send(raw)
            except ConnectionClosed:
                self._dead = True
                return
            except Exception:
                log.exception("websocket write failed")
                self._dead = True
                return

    def logout(self):
        self.close_all_apps()
        self.login, self.id, self.username, self.session_id, self.token_exp = False, -1, None, None, 0.0

    def close(self, code=1000, reason=""):
        with self._state_lock:
            if self.closed:
                return
            self.closed = True
        self.close_all_apps()
        if self._writer is not None and self._writer is not current_thread():
            self._writer.join(timeout=2.0)
        try:
            self.socket.close(code, reason)
        except Exception:
            pass

    def close_async(self, code=1000, reason=""):
        Thread(target=self.close, args=(code, reason), daemon=True, name="ws-closer").start()


class Server(object):
    def __init__(self, websocket_builder, *, close_message=None, burst=80, rate=40, max_per_user=20,
                 outbox_size=256, max_unauthenticated=200, pre_auth_max_bytes=16 * 1024, rate_strikes=200):
        self.websocket: WebSocketServer = websocket_builder(self._serve)

        self._routes = {}
        self.clients = {}
        self.users = {}
        self._lock = Lock()
        self._closing = False
        self._burst, self._rate, self._max_per_user = burst, rate, max_per_user
        self._outbox_size, self._max_unauth = outbox_size, max_unauthenticated
        self._pre_auth_max, self._rate_strikes = pre_auth_max_bytes, rate_strikes

        self.close_message: MessageJSON = close_message

        signal(SIGINT, lambda *args: Thread(target=self.close, daemon=True).start())
        signal(SIGTERM, lambda *args: Thread(target=self.close, daemon=True).start())

    def _serve(self, websocket: ServerConnection):
        client = Client(websocket, burst=self._burst, rate=self._rate, outbox_size=self._outbox_size)
        with self._lock:
            crowded = sum(1 for c in self.clients.values() if not c.login) >= self._max_unauth
            if not crowded:
                self.clients[websocket] = client
        if crowded:
            client.close(1013, "busy")
            return

        try:
            for raw in websocket:
                if not self._admit(client, raw):
                    if client.closed:
                        break
                    continue
                self._dispatch(client, raw)
        except ConnectionClosed:
            pass
        except Exception:
            log.exception("connection handler crashed")
        finally:
            self.unbind_user(client)
            client.close()
            with self._lock:
                self.clients.pop(websocket, None)

    def _admit(self, client: Client, raw) -> bool:
        if not client.login and len(raw) > self._pre_auth_max:
            client.close(1009, "message_too_big")
            return False
        if client.bucket.allow():
            client.strikes = 0
            return True
        client.strikes += 1
        client.send_message(MessageJSON("rate_limited", {"message": "slow_down"}, code=429, rid=cheap_rid(raw)))
        if client.strikes >= self._rate_strikes:
            client.close(1008, "rate_limited")
        return False

    def _dispatch(self, client: Client, raw):
        try:
            message = MessageJSON.from_raw(raw)
        except ProtocolError as exc:
            client.send_message(MessageJSON("invalid_message", {"message": str(exc)}, code=1, rid=cheap_rid(raw)))
            return
        route = self._routes.get(message.action)
        if not route:
            client.send_message(MessageJSON("invalid_action", {"message": message.action}, code=1, rid=message.rid))
            return
        try:
            route(self, client, message)
        except ConnectionClosed:
            raise
        except Exception:
            log.error("[route %s] %s", message.action, format_exc())
            client.send_message(MessageJSON(message.action, {"message": "internal_error"}, code=500, rid=message.rid))

    def add_route(self, name, callback):
        self._routes[name] = callback

    def bind_user(self, client: Client) -> bool:
        evicted = []
        with self._lock:
            bucket = self.users.setdefault(client.id, set())
            if client not in bucket:
                while len(bucket) >= self._max_per_user:
                    oldest = min(bucket, key=lambda c: c.connected_at)
                    bucket.discard(oldest)
                    evicted.append(oldest)
            bucket.add(client)
        for old in evicted:
            old.send_message(MessageJSON("session_ended", {"message": "too_many_connections"}, code=409))
            old.close_async(CLOSE_REPLACED, "too_many_connections")
        return True

    def unbind_user(self, client: Client):
        with self._lock:
            for user_id in [u for u, members in self.users.items() if client in members]:
                self.users[user_id].discard(client)
                if not self.users[user_id]:
                    del self.users[user_id]

    def clients_of(self, user_id: int) -> list:
        with self._lock:
            return list(self.users.get(user_id, ()))

    def publish(self, user_id: int, topic: str, payload: dict, exclude_app=None):
        for client in self.clients_of(user_id):
            self._deliver(client, topic, payload, exclude_app)

    def publish_all(self, topic: str, payload: dict):
        with self._lock:
            everyone = [c for members in self.users.values() for c in members]
        for client in everyone:
            self._deliver(client, topic, payload, None)

    @staticmethod
    def _deliver(client: Client, topic: str, payload: dict, exclude_app):
        for session in client.started_apps_sessions:
            app = session.app
            if app is exclude_app or topic not in app.topics or app.closed:
                continue
            try:
                data = app.on_event(topic, payload)
            except Exception:
                log.error(format_exc())
                continue
            if data is not None:
                client.send_message(MessageJSON(f"event_{session.session_id}", data=data))

    def kick_session(self, session_id: str, reason: str = "session_revoked"):
        with self._lock:
            victims = [c for c in self.clients.values() if c.session_id == session_id]
        for client in victims:
            client.send_message(MessageJSON("session_ended", {"message": reason}, code=401))
            client.close_async(CLOSE_UNAUTHORIZED, reason)

    def sweep_expired(self, hard_seconds: int):
        now = time()
        with self._lock:
            stale = [c for c in self.clients.values() if c.login and now > c.token_exp + hard_seconds]
        for client in stale:
            client.send_message(MessageJSON("session_ended", {"message": "token_expired"}, code=401))
            client.close_async(CLOSE_UNAUTHORIZED, "token_expired")

    def sweep_unauthenticated(self, timeout_seconds: float):
        cutoff = monotonic() - timeout_seconds
        with self._lock:
            idle = [c for c in self.clients.values() if not c.login and c.connected_at < cutoff]
        for client in idle:
            client.close_async(CLOSE_UNAUTHORIZED, "auth_timeout")

    def sweep(self, *, hard_expiry_seconds: int, auth_timeout_seconds: float):
        self.sweep_unauthenticated(auth_timeout_seconds)
        self.sweep_expired(hard_expiry_seconds)

    def serve(self):
        self.websocket.serve_forever()

    def close(self):
        if self._closing:
            return
        self._closing = True
        with self._lock:
            members = list(self.clients.values())
        for item in members:
            if self.close_message:
                item.send_message(self.close_message)
            item.close_async(1001, "server_shutdown")
        self.websocket.shutdown()
