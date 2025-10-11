from src import App

from os import remove, mkdir, scandir
from os.path import abspath
from os.path import join as join_path
from genericpath import isfile, isdir, exists
from shutil import rmtree

class ExplorerApp(App):
    def __init__(self, appdata_path: str):
        super().__init__(appdata_path)

        self.abs_client_root = abspath(join_path(appdata_path, "..", "root")).replace('\\', '/')
        self.path = self.join_path("explorer")

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
