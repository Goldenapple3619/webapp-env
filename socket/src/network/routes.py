from base64 import b64decode
from functools import wraps
from time import time
from traceback import format_exc
from uuid import uuid4

from ..auth import AuthError, authenticate
from ..common.userfs import FsError, UserFS
from ..config import Config
from .wsserver import AppContext, AppError, AppSession, MessageJSON

apps: dict = {}
db = None

def reply(client, message, action, data, code=0):
    client.send_message(MessageJSON(action, data=data, code=code, rid=message.rid))


def authed(action_name):
    def decorator(fn):
        @wraps(fn)
        def wrapper(server, client, message):
            if not client.login or client.id < 0:
                return reply(client, message, action_name, {"message": "not_loggedin"}, 1)
            if time() > client.token_exp + Config.token_grace_seconds:
                return reply(client, message, action_name, {"message": "token_expired"}, 401)
            return fn(server, client, message)

        return wrapper

    return decorator


def route_goodbye(server, client, message):
    reply(client, message, "goodbye", {"message": "ok"})
    client.close()

def route_ping(server, client, message):
    reply(client, message, "pong", {"t": time()})

def route_disconnect(server, client, message):
    if not client.login or client.id < 0:
        return reply(client, message, "disconnect", {"message": "not_logged_in"}, 1)
    server.unbind_user(client)
    client.logout()
    reply(client, message, "disconnect", {"message": "ok"})

def route_connect(server, client, message):
    """Also used to *re-authenticate* with a fresh access token on a socket that stays open."""
    token = message.data.get("token")
    if not isinstance(token, str) or not token:
        return reply(client, message, "connect", {"message": "ko", "reason": "missing_token"}, 1)
    try:
        identity = authenticate(db, token)
    except AuthError as exc:
        return reply(client, message, "connect", {"message": "ko", "reason": exc.reason}, 1)

    if client.login and client.session_id == identity.session_id:
        client.token_exp = identity.expires_at  # silent renewal
        return reply(client, message, "connect", {"message": "ok", "renewed": True, "expires_at": identity.expires_at})

    if client.login:  # a different identity on the same socket: drop everything of the old one
        server.unbind_user(client)
        client.logout()
    client.login, client.id, client.username = True, identity.user_id, identity.username
    client.session_id, client.token_exp = identity.session_id, identity.expires_at
    if not server.bind_user(client):
        client.logout()
        return reply(client, message, "connect", {"message": "ko", "reason": "too_many_connections"}, 1)
    reply(client, message, "connect", {
        "message": "ok", "user": {"id": identity.user_id, "username": identity.username},
        "session_id": identity.session_id, "expires_at": identity.expires_at, "apps": sorted(apps),
    })


@authed("start_app")
def route_start_app(server, client, message):
    identifier = message.data.get("identifier")
    action = f"start_app{'' if not identifier else '_' + str(identifier)}"
    name = message.data.get("name")
    if not isinstance(name, str) or name not in apps:
        return reply(client, message, action, {"message": "ko", "error": "unknown_app"}, 1)

    app_uuid = uuid4().hex
    root = f"{Config.system_root}/users/{client.id}"
    ctx = AppContext(user_id=client.id, username=client.username, appdata_path=f"{root}/appdata",
                     root_path=f"{root}/root", db=db, server=server)
    try:
        session = AppSession(app_uuid, apps[name](ctx))
    except (AppError, FsError) as exc:
        return reply(client, message, action, {"message": "ko", "error": exc.code}, 1)
    client.add_app(session)
    reply(client, message, action, {"message": "start_done", "session_id": app_uuid})

@authed("close_app")
def route_close_app(server, client, message):
    sid = message.data.get("app_session")
    if not client.get_app(sid):
        return reply(client, message, "close_app", {"message": "ko"}, 1)
    client.close_app(sid)
    reply(client, message, "close_app", {"message": "close_done"})

def _app_call(kind, ok, ko):
    def handler(server, client, message):
        data = message.data
        sid, type_ = data.get("app_session"), data.get(f"{kind}_type")
        session = client.get_app(sid)
        query = data.get("query", {})
        if not session or not isinstance(type_, str) or not isinstance(query, dict):
            return reply(client, message, f"{kind}_app", {"message": "ko"}, 1)
        action = f"{kind}_app_{sid}"
        try:
            result = (session.read if kind == "fetch" else session.write)(type_, **query)
        except (AppError, FsError) as exc:
            return reply(client, message, action, {"message": ko, "error": exc.code, "details": exc.details}, 1)
        except TypeError:
            return reply(client, message, action, {"message": ko, "error": "bad_query"}, 1)
        except OSError as exc:
            print(f"[{kind}_app] OS error: {exc!r}", flush=True)
            return reply(client, message, action, {"message": ko, "error": "io_error"}, 1)
        if result is None or result is False:
            return reply(client, message, action, {"message": ko, "error": "unsupported"}, 1)
        body = {"message": ok}
        if result is not True:
            body["value"] = result
        reply(client, message, action, body)

    return handler

route_fetch_app = authed("fetch_app")(_app_call("fetch", "fetch_done", "fetch_ko"))
route_update_app = authed("update_app")(_app_call("update", "update_done", "update_ko"))

@authed("write")
def route_write(server, client, message):
    """Small base64 writes (kept from the first version). Big files go through HTTP PUT /api/my/..."""
    data = message.data
    if not isinstance(data.get("path"), str) or not isinstance(data.get("content"), str):
        return reply(client, message, "write", {"message": "ko"}, 1)
    try:
        fs = UserFS(f"{Config.system_root}/users/{client.id}/root")
        target = fs.resolve(data["path"])
        raw = b64decode(data["content"], validate=True)
        if len(raw) > Config.max_message_bytes:
            raise FsError("too_large")
        with open(target, "wb") as fp:
            fp.write(raw)
    except FsError as exc:
        return reply(client, message, "write", {"message": "not_found" if exc.code == "not_found" else exc.code}, 1)
    except Exception:
        print(format_exc(), flush=True)
        return reply(client, message, "write", {"message": "writing_fail"}, 1)
    reply(client, message, "write", {"message": "write_done"})


def install(server):
    for name, handler in {
        "connect": route_connect, "disconnect": route_disconnect, "goodbye": route_goodbye, "ping": route_ping,
        "start_app": route_start_app, "close_app": route_close_app,
        "fetch_app": route_fetch_app, "update_app": route_update_app, "write": route_write,
    }.items():
        server.add_route(name, handler)
