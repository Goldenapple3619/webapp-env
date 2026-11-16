"""
The desktop's gateway app: everything the virtual desktop persists for a user.

  shortcuts   *.shc files in /desktop (XML, parsed and validated here - see src/common/shortcut.py)
  layout      where each icon sits on the desktop grid          -> appdata/desktop/layout.json
  appearance  background, taskbar, window frame, per-app themes -> appdata/desktop/appearance.json

It extends FsApp, so the desktop talks to ONE session for listing /desktop, moving, deleting... as well as for these.
Appdata is outside the folder users can browse, so it can only be changed through the validators below.
"""
import json
import os
import posixpath
import tempfile
import threading
from collections import defaultdict

from src import AppError, FsApp, FsError
from src.common import shortcut as sc
from src.common.appearance import AppearanceError, MAX_BYTES, normalize_appearance, normalize_layout
from src.common.userfs import is_virtual, valid_name

DESKTOP = "/desktop"
EMPTY_LAYOUT = {"version": 1, "seeded": False, "items": {}}
_locks = defaultdict(threading.Lock)  # per user: seeding / layout read-modify-write must not interleave


def _atomic_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _read_json(path: str):
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return None, None
        with open(path, "r", encoding="utf-8") as fp:
            return json.load(fp), str(os.stat(path).st_mtime_ns)
    except (OSError, ValueError):
        return None, None


def file_name_for(name: str) -> str:
    cleaned = "".join("_" if c in '/\\\0:*?"<>|' or ord(c) < 32 else c for c in name).strip(" .")[:60] or "Shortcut"
    return cleaned


class DesktopApp(FsApp):
    topics = ("fs", "desktop")

    def __init__(self, ctx):
        super().__init__(ctx)
        self.layout_file = self.join_path("desktop", "layout.json")
        self.appearance_file = self.join_path("desktop", "appearance.json")
        self._lock = _locks[ctx.user_id]

    def changed(self, op: str, dirs=(), files=()):
        """Unlike the Explorer (which reloads its own folder after each action), the desktop lives on events: it must hear about
        its OWN changes too - a deleted icon, a saved or created shortcut - so this does not exclude the originating session."""
        self.ctx.publish("fs", {"op": op, "dirs": sorted(set(dirs)), "files": sorted(set(files))})

    def on_event(self, topic, payload):
        if topic == "desktop":
            return {"event": "desktop_changed", **payload}
        return super().on_event(topic, payload)

    def _announce(self, kind: str, origin) -> None:
        payload = {"kind": kind, "origin": origin if isinstance(origin, str) and len(origin) <= 64 else ""}
        if self.ctx.db is not None:  # through Postgres so every gateway replica hears about it
            try:
                self.ctx.db.execute("SELECT pg_notify('desktop_events', %s)",
                                    (json.dumps({"user": self.ctx.user_id, **payload}),))
                return
            except Exception:
                pass
        self.ctx.publish("desktop", payload)

    def _read_shortcut(self, path: str) -> dict:
        """One .shc file -> {path, mtime, shortcut | error, warnings}. Never raises for bad content."""
        out = {"path": path, "warnings": []}
        try:
            info = self.fs.read_text(path, limit=sc.MAX_BYTES)
        except FsError as exc:
            out["error"] = exc.code
            return out
        out["mtime"] = info["mtime"]
        try:
            shortcut, warnings = sc.parse(info["content"])
        except sc.ShortcutError as exc:
            out["error"] = exc.code
            out["detail"] = exc.detail
            return out
        out["shortcut"], out["warnings"] = shortcut, warnings
        return out

    def _shortcuts_in(self, listing: list) -> list:
        found = [e for e in listing if e["type"] == "file" and e["ext"] == "shc"][:500]
        return [self._read_shortcut(e["path"]) for e in found]

    def _load_layout(self) -> tuple[dict, str]:
        raw, version = _read_json(self.layout_file)
        try:
            return normalize_layout(raw if raw is not None else EMPTY_LAYOUT), version or ""
        except AppearanceError:
            return dict(EMPTY_LAYOUT), ""

    def _save_layout(self, layout: dict) -> str:
        clean = normalize_layout(layout)
        _atomic_write(self.layout_file, json.dumps(clean))
        return str(os.stat(self.layout_file).st_mtime_ns)

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "snapshot":  # one round trip for the whole desktop
            try:
                listing = self.fs.listdir(DESKTOP)["content"]
            except FsError:
                listing = []
            layout, version = self._load_layout()
            return {"type": "snapshot", "content": listing, "shortcuts": self._shortcuts_in(listing),
                    "layout": layout, "layout_version": version}
        if fetch_type == "shortcut":
            return {"type": "shortcut", **self._read_shortcut(str(kwargs.get("path", "")))}
        if fetch_type == "layout":
            layout, version = self._load_layout()
            return {"type": "layout", "layout": layout, "version": version}
        if fetch_type == "appearance":
            raw, version = _read_json(self.appearance_file)
            try:
                value = normalize_appearance(raw) if raw is not None else None
            except AppearanceError:
                value = None
            return {"type": "appearance", "appearance": value, "version": version or ""}
        return super().fetch(fetch_type, **kwargs)

    def _create_shortcut_file(self, folder: str, data: dict) -> dict:
        data = sc.normalize(data)
        base = file_name_for(data["name"])
        for n in range(1, 200):
            name = f"{base}.shc" if n == 1 else f"{base} ({n}).shc"
            try:
                path = self.fs.mkfile(folder, name)
            except FsError as exc:
                if exc.code == "exists":
                    continue
                raise
            self.fs.write_text(path, sc.serialize(data))
            return {"path": path, "shortcut": data}
        raise AppError("exists", "too many shortcuts with that name")

    def write(self, update_type, **kwargs):
        if update_type == "shortcut_save":
            path = kwargs.get("path")
            if not isinstance(path, str) or not path.lower().endswith(".shc") or is_virtual(path):
                raise AppError("invalid_path", "a shortcut file ends with .shc")
            try:
                data = sc.normalize(kwargs.get("shortcut"))
                result = self.fs.write_text(path, sc.serialize(data), base_mtime=kwargs.get("base_mtime"),
                                            force=bool(kwargs.get("force")))
            except sc.ShortcutError as exc:
                raise AppError(exc.code, exc.detail, detail=exc.detail)
            self.changed("save", files=[result["path"]], dirs=[posixpath.dirname(result["path"]) or "/"])
            return {"path": result["path"], "mtime": result["mtime"], "shortcut": data}

        if update_type == "shortcut_create":
            folder = kwargs.get("dir") or DESKTOP
            try:
                made = self._create_shortcut_file(folder, kwargs.get("shortcut"))
            except sc.ShortcutError as exc:
                raise AppError(exc.code, exc.detail, detail=exc.detail)
            self.changed("mkfile", dirs=[folder], files=[made["path"]])
            return made

        if update_type == "shortcuts_seed":
            return self._seed(kwargs.get("items"), bool(kwargs.get("force")), kwargs.get("origin"))

        if update_type == "layout_save":
            try:
                layout = normalize_layout(kwargs.get("layout"))
            except AppearanceError as exc:
                raise AppError(exc.code, exc.detail, detail=exc.detail)
            with self._lock:
                current, version = self._load_layout()
                base = kwargs.get("base_version")
                if base is not None and str(base) != version and not kwargs.get("force"):
                    raise AppError("conflict", "the layout changed in another window", layout=current, version=version)
                layout["seeded"] = layout["seeded"] or current["seeded"]
                version = self._save_layout(layout)
            self._announce("layout", kwargs.get("origin"))
            return {"version": version}

        if update_type == "appearance_save":
            try:
                value = normalize_appearance(kwargs.get("appearance"))
            except AppearanceError as exc:
                raise AppError(exc.code, exc.detail, detail=exc.detail)
            text = json.dumps(value)
            if len(text) > MAX_BYTES:
                raise AppError("too_large", "appearance is too large")
            _atomic_write(self.appearance_file, text)
            self._announce("appearance", kwargs.get("origin"))
            return {"appearance": value}

        if update_type == "appearance_reset":
            try:
                os.remove(self.appearance_file)
            except FileNotFoundError:
                pass
            self._announce("appearance", kwargs.get("origin"))
            return True

        return super().write(update_type, **kwargs)

    def _seed(self, items, force: bool, origin) -> dict:
        """Creates the default shortcuts once per user (the client knows which apps exist). Idempotent and race-safe."""
        if not isinstance(items, list) or len(items) > 24:
            raise AppError("invalid_args", "items: a list of at most 24 shortcuts")
        created = []
        with self._lock:
            layout, _ = self._load_layout()
            if layout["seeded"] and not force:
                return {"created": [], "skipped": True}
            try:
                os.makedirs(self.fs.resolve(DESKTOP), exist_ok=True)
            except FsError:
                pass
            try:
                have = {r["shortcut"]["open"] for r in self._shortcuts_in(self.fs.listdir(DESKTOP)["content"]) if "shortcut" in r}
            except FsError:
                have = set()
            for item in items:
                try:
                    clean = sc.normalize(item)
                except sc.ShortcutError as exc:
                    raise AppError(exc.code, exc.detail, detail=exc.detail)
                if clean["open"] in have and not clean["target"]:
                    continue
                created.append(self._create_shortcut_file(DESKTOP, clean)["path"])
            layout["seeded"] = True
            self._save_layout(layout)
        if created:
            self.changed("mkfile", dirs=[DESKTOP], files=created)
        self._announce("layout", origin)
        return {"created": created}
