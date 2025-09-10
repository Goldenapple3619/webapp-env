from src import *

from websockets.sync.server import serve
from genericpath import isfile, isdir, exists
from sys import exit
from os import environ, listdir, remove, mkdir, scandir
from traceback import format_exc
from uuid import uuid4
from os.path import abspath, getsize, getctime, getmtime
from os.path import join as join_path
from base64 import b64decode
from shutil import rmtree

import sys

db = DataBase(environ["DB_HOST"], environ["POSTGRES_DB"], environ["POSTGRES_USER"], environ["POSTGRES_PASSWORD"])

class ExplorerApp(App):
    def __init__(self, appdata_path: str):
        super().__init__(appdata_path)

        self.abs_client_root = abspath(join_path(appdata_path, "..", "root")).replace('\\', '/')
        self.path = self.join_path("Explorer")

    def write(self, update_type, **kwargs):
        if (not "path" in kwargs):
            return (False)

        if (kwargs["path"].replace('\\', '/').startswith('/')):
            kwargs["path"] = "." + kwargs["path"]

        path = abspath(join_path(self.abs_client_root, kwargs["path"].replace('\\', '/'))).replace('\\', '/')

        if (not path.startswith(self.abs_client_root) or not exists(path)):
            return (False)

        if (update_type == "mkdir"):
            if (isdir(path)):
                return (True)
            mkdir(path)
            return (True)

        if (update_type == "mkfile"):
            open(path, 'wb+').close()
            return (True)

        if (update_type == "rmdir"):
            if (not isdir(path)):
                return (False)
            rmtree(path, True)
            return (True)

        if (update_type == "rmfile"):
            if (not isfile(path)):
                return (False)
            remove(path)
            return (True)

        return (False)

    def fetch(self, fetch_type, **kwargs):
        if (not "path" in kwargs):
            return (False)

        if (kwargs["path"].replace('\\', '/').startswith('/')):
            kwargs["path"] = "." + kwargs["path"]

        path = abspath(join_path(self.abs_client_root, kwargs["path"].replace('\\', '/'))).replace('\\', '/')

        if (not path.startswith(self.abs_client_root) or not exists(path)):
            return (False)

        if (fetch_type == "listdir"):

            if (not isdir(path)):
                return (None)

            return {"type": fetch_type, "fetched": path.replace(self.abs_client_root, ''), "content":
                list(map(lambda x: {
                    "name": x.name,
                    "path": join_path(path, x.name).replace(self.abs_client_root, ''),
                    "icon": None,
                    "type": "folder" if x.is_dir() else "file",
                    "size": 0 if x.is_dir() else x.stat().st_size,
                    "creation_date": x.stat().st_ctime,
                    "modification_date": x.stat().st_mtime
                }, scandir(path)))
            }

        return (None)

    def save(self):
        return super().save()

    def load(self):
        return super().load()

class MusicApp(App):
    def __init__(self, appdata_path: str):
        super().__init__(appdata_path)

        self.path = self.join_path("musicApp")
        self.abs_client_root = abspath(join_path(appdata_path, "..", "root")).replace('\\', '/')

        self.playlists = {}

    def write(self, update_type, **kwargs):
        if (update_type == "playlists_create"):
            if (not "name" in kwargs or kwargs["name"] in self.playlists):
                return (False)
            self.playlists[kwargs["name"]] = []
            return (True)

        if (update_type == "playlists_delete"):
            if (not "name" in kwargs or kwargs["name"] not in self.playlists):
                return (False)
            if (isfile(self.join_path("playlists", kwargs["name"] + ".lst"))):
                remove(self.join_path("playlists", kwargs["name"] + ".lst"))
            del self.playlists[kwargs["name"]]
            return (True)

        if (update_type == "song_add"):
            if (not "playlist" in kwargs or kwargs["playlist"] not in self.playlists):
                return (False)
            if (not "path" in kwargs or join_path(self.abs_client_root, kwargs["path"].replace('\\', '/').lstrip('/'))):
                return (False)
            self.playlists[kwargs["name"]].append({"endpoint": kwargs["path"].replace('\\', '/'), "cover": kwargs.get("cover", "default"), "name": kwargs.get("name", '.'.join(kwargs["path"].replace('\\', '/').split('/')[-1].split('.')[:-1]))})
            return (True)

        if (update_type == "song_delete"):
            if (not "playlist" in kwargs or kwargs["playlist"] not in self.playlists):
                return (False)
            if (not "id" in kwargs or kwargs["id"].isnumeric() or int(kwargs["id"]) >= len(self.playlists[kwargs["playlist"]])):
                return (False)
            del kwargs["playlist"][int(kwargs["id"])]
            return (True)

        return (False)

    def fetch(self, fetch_type, **kwargs):
        if (fetch_type == "playlists"):
            return {"type": fetch_type, "content": [{"name": item, "songs": self.playlists[item]} for item in self.playlists]}

        return (None)

    def save(self):
        for item in self.playlists:
            with open(self.join_path("playlists", item + '.lst'), 'w') as fp:
                for song in sorted(self.playlists[item], key=lambda x: x["id"]):
                    fp.write(f"{song['endpoint']} {song['cover']} {song['name']}\n")

        return super().save()

    def load(self):
        self.playlists.clear()

        for item in listdir(self.join_path("playlists")):
            song_id = 0

            self.playlists['.'.join(item.split('.')[:-1])] = []

            with open(self.join_path("playlists", item), 'r') as fp:
                for line in fp.readlines():
                    line = line.strip()

                    if (not line):
                        continue

                    music, cover, *name = tuple(filter(lambda x: x != "", line.replace('\t', '').split(' ')))

                    self.playlists[item.split('.')[0]].append({"id": song_id, "endpoint": music, "name": ' '.join(name), "cover": cover})

                    song_id += 1

        return super().load()

apps = {
    "music": MusicApp,
    "explorer": ExplorerApp
}

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

def main() -> int:
    S = Server(lambda s: serve(s, "0.0.0.0", 80), close_message=MessageJSON("goodbye", data={"message": "connection_end"}, code=0))

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
