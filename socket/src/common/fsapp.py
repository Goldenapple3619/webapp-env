import posixpath

from ..network.wsserver import App, AppError
from .userfs import UserFS

PLACES = [("Desktop", "/desktop"), ("Documents", "/documents"), ("Downloads", "/downloads"),
          ("Music", "/music"), ("Pictures", "/pictures"), ("Videos", "/videos")]

def _paths(kwargs) -> list:
    paths = kwargs.get("paths")
    if paths is None and "path" in kwargs:
        paths = [kwargs["path"]]
    if not isinstance(paths, list) or not paths or len(paths) > 500 or not all(isinstance(p, str) for p in paths):
        raise AppError("invalid_paths")
    return paths

class FsApp(App):
    topics = ("fs",)

    def __init__(self, ctx):
        super().__init__(ctx)
        self.fs = UserFS(ctx.root_path)

    def changed(self, op: str, dirs=(), files=()):
        payload = {"op": op, "dirs": sorted(set(dirs)), "files": sorted(set(files))}
        self.ctx.publish("fs", payload, source=self)

    def on_event(self, topic, payload):
        if topic != "fs":
            return None
        if payload.get("resync"):
            return {"event": "restore"}
        return {"event": "fs_changed", **payload}

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "listdir":
            return self.fs.listdir(kwargs.get("path", "/"))
        if fetch_type == "stat":
            return {"type": "stat", "stat": self.fs.stat(kwargs.get("path", "/"))}
        if fetch_type == "search":
            return self.fs.search(kwargs.get("path", "/"), kwargs.get("query", ""))
        if fetch_type == "places":
            existing = [{"name": n, "path": p} for n, p in PLACES if self._is_dir(p)]
            return {"type": "places", "content": existing}
        return None

    def _is_dir(self, path) -> bool:
        try:
            return self.fs.stat(path)["type"] == "folder"
        except AppError:
            return False

    @staticmethod
    def _parent_and_name(kwargs):
        path, name = kwargs.get("path"), kwargs.get("name")
        if not isinstance(path, str):
            raise AppError("invalid_path")
        if name is None:
            parent, name = posixpath.split(path.replace("\\", "/").rstrip("/"))
            return parent or "/", name
        return path, name

    def write(self, update_type, **kwargs):
        if update_type in ("mkdir", "mkfile"):
            parent, name = self._parent_and_name(kwargs)
            created = (self.fs.mkdir if update_type == "mkdir" else self.fs.mkfile)(parent, name)
            self.changed(update_type, dirs=[self.fs.rel(self.fs.resolve(parent))])
            return {"path": created}

        if update_type == "rename":
            old = kwargs.get("path")
            new = self.fs.rename(old, kwargs.get("name"))
            self.changed("rename", dirs=[posixpath.dirname(new) or "/"], files=[old, new])
            return {"path": new, "old": old}

        if update_type in ("move", "copy"):
            sources, dest = _paths(kwargs), kwargs.get("dest")
            result = (self.fs.move if update_type == "move" else self.fs.copy)(sources, dest)
            dirs = [self.fs.rel(self.fs.resolve(dest))]
            if update_type == "move":
                dirs += [posixpath.dirname(self.fs.resolve_rel(s)) or "/" for s in sources]
            self.changed(update_type, dirs=dirs, files=sources + result)
            return {"paths": result}

        if update_type in ("delete", "rmdir", "rmfile"):  # rmdir / rmfile: names of the first version
            sources = _paths(kwargs)
            removed = [self.fs.delete(p) for p in sources]
            self.changed("delete", dirs=[posixpath.dirname(p) or "/" for p in removed], files=removed)
            return {"paths": removed}

        return False
