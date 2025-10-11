from src import *

from websockets.sync.server import serve

from sys import exit
from traceback import format_exc

from genericpath import isdir
from os import environ
from os.path import abspath
from os.path import join as join_path

from uuid import uuid4
from base64 import b64decode

from xml.etree import ElementTree
from importlib.util import spec_from_file_location, module_from_spec

import sys


db: DataBase = DataBase(environ["DB_HOST"], environ["POSTGRES_DB"], environ["POSTGRES_USER"], environ["POSTGRES_PASSWORD"])
apps: dict = {}

def route_goodbye(server: Server, client: Client, message: MessageJSON):
    client.send_message(MessageJSON("goodbye", data={"message": "ok"}, code=0))
    client.close()

def route_disconnect(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id < 0):
        client.send_message(MessageJSON("disconnect", data={"message": "not_logged_in"}, code=1))
        return

    for item in client.started_apps_sessions:
        item.close()
    client.started_apps_sessions.clear()

    client.login = False
    client.id = -1
    client.send_message(MessageJSON("disconnect", data={"message": "ok"}, code=0))

def route_connect(server: Server, client: Client, message: MessageJSON):
    if (not message.data or "token" not in message.data or not message.data["token"]):
        client.send_message(MessageJSON("connect", data={"message": "ko"}, code=1))
        return

    user = db.fetch_dao("users", User, r"WHERE token=%s", [message.data["token"]])

    if (not user):
        client.send_message(MessageJSON("connect", data={"message": "ko"}, code=1))
        return

    client.send_message(MessageJSON("connect", data={"message": "ok"}, code=0))
    client.login = True
    client.id = user[0].id

def route_start_app(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id == -1):
        client.send_message(MessageJSON("start_app", data={"message": "not_loggedin"}, code=1))
        return
    if (not message.data or "name" not in message.data or message.data["name"] not in apps):
        client.send_message(MessageJSON("start_app", data={"message": "ko"}, code=1))
        return

    app_uuid = uuid4().hex
    client.started_apps_sessions.append(AppSession(app_uuid, apps[message.data["name"]](f"/mnt/system/users/{client.id}/appdata")))
    client.send_message(MessageJSON(f"start_app{'' if not message.data['identifier'] else ('_' + message.data['identifier'])}", data={"message": "start_done", "session_id": app_uuid}, code=0))

def route_close_app(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id == -1):
        client.send_message(MessageJSON("close_app", data={"message": "not_loggedin"}, code=1))
        return
    if (not message.data or "app_session" not in message.data or not client.get_app(message.data["app_session"])):
        client.send_message(MessageJSON("close_app", data={"message": "ko"}, code=1))
        return
    client.close_app(message.data["app_session"])
    client.send_message(MessageJSON("close_app", data={"message": "close_done"}, code=0))

def update_app(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id == -1):
        client.send_message(MessageJSON("update_app", data={"message": "not_loggedin"}, code=1))
        return
    if (not message.data or "app_session" not in message.data or "update_type" not in message.data or not client.get_app(message.data["app_session"])):
        client.send_message(MessageJSON("update_app", data={"message": "ko"}, code=1))
        return

    app = client.get_app(message.data["app_session"])

    app.save()

    if (not app.write(message.data["update_type"], **(message.data["query"] if "query" in message.data else {}), client=client)):
        client.send_message(MessageJSON(f"update_app_{message.data['app_session']}", data={"message": "update_ko"}, code=1))
        return

    for item in client.started_apps_sessions:
        if (id(item) != id(app) and isinstance(item, app.__class__)):
            item.load()

    client.send_message(MessageJSON(f"update_app_{message.data['app_session']}", data={"message": "update_done"}, code=0))

def fetch_app(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id == -1):
        client.send_message(MessageJSON("fetch_app", data={"message": "not_loggedin"}, code=1))
        return
    if (not message.data or "app_session" not in message.data or "fetch_type" not in message.data or not client.get_app(message.data["app_session"])):
        client.send_message(MessageJSON("fetch_app", data={"message": "ko"}, code=1))
        return

    app = client.get_app(message.data["app_session"])
    data = app.read(message.data["fetch_type"], **(message.data["query"] if "query" in message.data else {}), client=client)

    if (not data):
        client.send_message(MessageJSON(f"fetch_app_{message.data['app_session']}", data={"message": "fetch_ko"}, code=1))
        return

    client.send_message(MessageJSON(f"fetch_app_{message.data['app_session']}", data={"message": "fetch_done", "value": data}, code=0))


def route_write(server: Server, client: Client, message: MessageJSON):
    if (not client.login or client.id == -1):
        client.send_message(MessageJSON("write", data={"message": "not_loggedin"}, code=1))
        return
    if (not message.data or "content" not in message.data or "path" not in message.data):
        client.send_message(MessageJSON("write", data={"message": "ko"}, code=1))
        return

    path = abspath(join_path(f"/mnt/system/users/{client.id}/root", message.data["path"].replace('\\', '/'))).replace('\\', '/')

    if (not path.startswith(f"/mnt/system/users/{client.id}/root") or not isdir('/'.join(path.split('/')[:-1]))):
        client.send_message(MessageJSON("write", data={"message": "not_found"}, code=1))
        return

    try:
        with open(path, 'wb') as fp:
            fp.write(b64decode(message.data["content"]))
    except Exception:
        client.send_message(MessageJSON("write", data={"message": "writing_fail"}, code=1))
        return

    client.send_message(MessageJSON(f"write", data={"message": "write_done"}, code=0))

def load_apps(config_file: str):
    tree = ElementTree.parse(config_file)
    root = tree.getroot()

    if (root.tag != "applist"):
        raise KeyError(f"invalid root tag {root.tag}, excepted 'applist'.")
    
    for item in root:
        if (item.tag != "app"):
            raise KeyError(f"all tag in applist should be <app>, got: {item.tag}.")
        if (not item.text):
            raise NameError("name of an app should'nt be empty.")
        if (not item.attrib.get("className", '')):
            raise NameError("className attribute shouldn't be empty.")
        if (not item.attrib.get("src", '')):
            raise NameError("src attribute shouldn't be empty.")
        
        if (item.text in apps):
            raise KeyError(f"{item.text} already registered in apps, can't register it twice.")
        
        spec = spec_from_file_location(f"app-{hash_file(item.attrib.get("src"))}", item.attrib.get("src"))
        mod = module_from_spec(spec)
        spec.loader.exec_module(mod)

        if (not hasattr(mod, item.attrib.get("className"))):
            raise KeyError(f"class {item.attrib.get("className")} is not in {item.attrib.get("src")}")

        apps[item.text] = getattr(mod, item.attrib.get("className"))

    print(apps)

def main() -> int:
    S: Server = Server(lambda s: serve(s, "0.0.0.0", 80), close_message=MessageJSON("goodbye", data={"message": "connection_end"}, code=0))

    try:
        load_apps("apps.xml")
    except Exception as e:
        print(e)
        return (1)

    S.add_route("connect", route_connect)
    S.add_route("disconnect", route_disconnect)
    S.add_route("goodbye", route_goodbye)
    S.add_route("start_app", route_start_app)
    S.add_route("close_app", route_close_app)
    S.add_route("fetch_app", fetch_app)
    S.add_route("update_app", update_app)
    S.add_route("write", route_write)

    try:
        S.serve()
    except Exception as e:
        print(f"Uncaught exception: '{format_exc()}'.", file=sys.stderr, flush=True)
        return (1)

    S.close()
    db.close()

    return (0)

if (__name__ == "__main__"):
    exit(main())
