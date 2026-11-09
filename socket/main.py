from http import HTTPStatus
from importlib.util import module_from_spec, spec_from_file_location
from sys import exit
from threading import Event, Thread
from traceback import format_exc
from xml.etree import ElementTree
import logging
import sys

from websockets.sync.server import serve

from src import *
from src.config import Config
from src.events import PgListener
from src.network import routes
from src.network.origins import origin_allowed


def load_apps(config_file: str) -> dict:
    root = ElementTree.parse(config_file).getroot()
    if root.tag != "applist":
        raise KeyError(f"invalid root tag {root.tag}, excepted 'applist'.")

    loaded = {}
    for item in root:
        src, class_name = item.attrib.get("src", ""), item.attrib.get("className", "")
        if item.tag != "app":
            raise KeyError(f"all tag in applist should be <app>, got: {item.tag}.")
        if not item.text or not item.text.strip():
            raise NameError("name of an app should'nt be empty.")
        if not class_name:
            raise NameError("className attribute shouldn't be empty.")
        if not src:
            raise NameError("src attribute shouldn't be empty.")

        name = item.text.strip()
        if name in loaded:
            raise KeyError(f"{name} already registered in apps, can't register it twice.")

        spec = spec_from_file_location(f"app-{hash_file(src)}", src)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        if not hasattr(module, class_name):
            raise KeyError(f"class {class_name} is not in {src}")
        loaded[name] = getattr(module, class_name)
    return loaded


def make_process_request(database):
    def process_request(connection, request):
        if request.path == "/healthz":
            if database.ping():
                return connection.respond(HTTPStatus.OK, "ok\n")
            return connection.respond(HTTPStatus.SERVICE_UNAVAILABLE, "db_unreachable\n")
        if not origin_allowed(request.headers.get("Origin"), request.headers.get("Host"), Config.allowed_origins):
            return connection.respond(HTTPStatus.FORBIDDEN, "origin_not_allowed\n")
        return None

    return process_request


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    try:
        Config.validate()
        routes.apps.update(load_apps("apps.xml"))
    except Exception as e:
        print(e, file=sys.stderr, flush=True)
        return 1

    database = DataBase(Config.db_host, Config.db_name, Config.db_user, Config.db_password,
                        port=Config.db_port, pool_size=Config.db_pool_size)
    routes.db = database
    print(f"[*] apps: {', '.join(sorted(routes.apps))}", flush=True)

    S: Server = Server(
        lambda handler: serve(
            handler, Config.host, Config.port,
            max_size=Config.max_message_bytes,
            process_request=make_process_request(database),
            ping_interval=20, ping_timeout=30,
            close_timeout=3,
        ),
        close_message=MessageJSON("goodbye", data={"message": "connection_end"}, code=0),
        burst=Config.rate_burst, rate=Config.rate_per_second, max_per_user=Config.max_connections_per_user,
        outbox_size=Config.outbox_size, max_unauthenticated=Config.max_unauthenticated,
        pre_auth_max_bytes=Config.pre_auth_max_bytes, rate_strikes=Config.rate_strikes,
    )
    routes.install(S)

    listener = PgListener(database.dsn_kwargs(), {
        "fs_events": lambda p: S.publish(int(p["user"]), "fs", {
            "op": p.get("op", "upload"), "dirs": p.get("dirs", []), "files": p.get("files", []), "resync": bool(p.get("resync"))}),
        "session_events": lambda p: S.kick_session(str(p["sid"])) if p.get("event") == "revoked" else None,
    },
        on_resync=lambda: S.publish_all("fs", {"op": "resync", "dirs": [], "files": [], "resync": True}))
    listener.start()

    stop = Event()

    def sweeper():
        while not stop.wait(5):
            try:
                S.sweep(hard_expiry_seconds=Config.hard_expiry_seconds, auth_timeout_seconds=Config.auth_timeout_seconds)
            except Exception:
                print(format_exc(), flush=True)

    Thread(target=sweeper, daemon=True, name="sweeper").start()

    print(f"[*] gateway listening on :{Config.port}", flush=True)
    try:
        S.serve()
    except Exception:
        print(f"Uncaught exception: '{format_exc()}'.", file=sys.stderr, flush=True)
        return 1
    finally:
        stop.set()
        listener.stop()
        S.close()
        database.close()
    return 0


if __name__ == "__main__":
    exit(main())
