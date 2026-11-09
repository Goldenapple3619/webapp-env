import os
import posixpath

from src import App, AppError, UserFS

AUDIO_EXT = {".mp3", ".ogg", ".wav", ".flac", ".m4a", ".aac", ".opus"}
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp")
COVER_NAMES = ("cover", "folder", "front", "album")
MAX_LIBRARY = 5000

def _clean_name(value) -> str:
    name = str(value or "").strip()
    if not 1 <= len(name) <= 120:
        raise AppError("invalid_name")
    return name

class MusicApp(App):
    topics = ("fs", "playlists")

    def __init__(self, ctx):
        super().__init__(ctx)
        self.fs = UserFS(ctx.root_path)
        self.db = ctx.db
        self._library = None

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "playlists":
            return {"type": fetch_type, "content": self._playlists()}
        if fetch_type == "library":
            if self._library is None:
                self._library = self._scan()
            return {"type": fetch_type, "content": self._library["files"], "truncated": self._library["truncated"]}
        return None

    def _playlists(self) -> list:
        uid = self.ctx.user_id
        lists = self.db.fetch_all("SELECT id, name FROM playlists WHERE user_id = %s ORDER BY lower(name)", (uid,))
        songs = self.db.fetch_all(
            """SELECT s.id, s.playlist_id, s.name, s.endpoint, s.cover FROM playlist_songs s
                 JOIN playlists p ON p.id = s.playlist_id WHERE p.user_id = %s ORDER BY s.playlist_id, s.position""", (uid,))
        by_list = {pid: [] for pid, _ in lists}
        for sid, pid, name, endpoint, cover in songs:
            by_list[pid].append({
                "id": sid, "name": name, "endpoint": endpoint,
                "cover": cover or self._cover_for(endpoint),
                "missing": not os.path.isfile(self._safe(endpoint) or ""),
            })
        return [{"id": pid, "name": name, "songs": by_list[pid]} for pid, name in lists]

    def _safe(self, path):
        try:
            return self.fs.resolve(path)
        except AppError:
            return None

    def _cover_for(self, endpoint):
        folder = posixpath.dirname(endpoint)
        stem = posixpath.splitext(posixpath.basename(endpoint))[0]
        base = self._safe(folder)
        if not base or not os.path.isdir(base):
            return None
        try:
            names = {n.lower(): n for n in os.listdir(base)}
        except OSError:
            return None
        for candidate in [stem.lower(), *COVER_NAMES]:
            for ext in IMAGE_EXT:
                if candidate + ext in names:
                    return posixpath.join(folder, names[candidate + ext])
        return None

    def _scan(self) -> dict:
        files, truncated = [], False
        for current, dirs, names in os.walk(self.fs.root):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for name in sorted(names):
                stem, ext = os.path.splitext(name)
                if ext.lower() not in AUDIO_EXT:
                    continue
                if len(files) >= MAX_LIBRARY:
                    return {"files": files, "truncated": True}
                full = os.path.join(current, name)
                rel = self.fs.rel(full)
                files.append({"name": stem, "path": rel, "size": os.path.getsize(full), "cover": self._cover_for(rel)})
        return {"files": files, "truncated": truncated}

    def _owned(self, playlist_id) -> int:
        row = self.db.fetch_one("SELECT id FROM playlists WHERE id = %s AND user_id = %s", (playlist_id, self.ctx.user_id))
        if not row:
            raise AppError("not_found")
        return row[0]

    def write(self, update_type, **kwargs):
        uid = self.ctx.user_id

        if update_type == "playlists_create":
            name = _clean_name(kwargs.get("name"))
            try:
                row = self.db.fetch_one("INSERT INTO playlists (user_id, name) VALUES (%s, %s) RETURNING id", (uid, name))
            except Exception as exc:
                if getattr(exc, "pgcode", None) == "23505":
                    raise AppError("exists")
                raise
            return self._done({"id": row[0], "name": name})

        if update_type == "playlists_rename":
            pid = self._owned(kwargs.get("id"))
            name = _clean_name(kwargs.get("name"))
            try:
                self.db.execute("UPDATE playlists SET name = %s, updated_at = now() WHERE id = %s", (name, pid))
            except Exception as exc:
                if getattr(exc, "pgcode", None) == "23505":
                    raise AppError("exists")
                raise
            return self._done({"id": pid, "name": name})

        if update_type == "playlists_delete":
            pid = self._owned(kwargs.get("id"))
            self.db.execute("DELETE FROM playlists WHERE id = %s", (pid,))
            return self._done({"id": pid})

        if update_type == "song_add":
            pid = self._owned(kwargs.get("playlist"))
            paths = kwargs.get("paths") or ([kwargs["path"]] if "path" in kwargs else [])
            if not isinstance(paths, list) or not paths or len(paths) > 500:
                raise AppError("invalid_paths")
            songs = []
            for raw in paths:
                real = self._safe(raw)
                rel = self.fs.rel(real) if real else None
                if not real or not os.path.isfile(real) or os.path.splitext(real)[1].lower() not in AUDIO_EXT:
                    raise AppError("not_audio", path=str(raw))
                songs.append((os.path.splitext(os.path.basename(real))[0], rel))
            start = self.db.fetch_one("SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = %s", (pid,))[0]
            with self.db.cursor() as cur:
                for offset, (name, rel) in enumerate(songs):
                    cur.execute("INSERT INTO playlist_songs (playlist_id, position, name, endpoint) VALUES (%s, %s, %s, %s)",
                                (pid, start + offset, name, rel))
                cur.execute("UPDATE playlists SET updated_at = now() WHERE id = %s", (pid,))
            return self._done({"playlist": pid, "added": len(songs)})

        if update_type in ("song_delete", "song_move"):
            pid = self._owned(kwargs.get("playlist"))
            ids = [r[0] for r in self.db.fetch_all("SELECT id FROM playlist_songs WHERE playlist_id = %s ORDER BY position", (pid,))]
            song = kwargs.get("id")
            if song not in ids:
                raise AppError("not_found")
            if update_type == "song_delete":
                ids.remove(song)
                self.db.execute("DELETE FROM playlist_songs WHERE id = %s", (song,))
            else:
                target = kwargs.get("position")
                if not isinstance(target, int):
                    raise AppError("invalid_position")
                ids.remove(song)
                ids.insert(max(0, min(target, len(ids))), song)
            with self.db.cursor() as cur:  # renumber 0..n-1: positions stay dense and unambiguous
                for position, sid in enumerate(ids):
                    cur.execute("UPDATE playlist_songs SET position = %s WHERE id = %s", (position, sid))
                cur.execute("UPDATE playlists SET updated_at = now() WHERE id = %s", (pid,))
            return self._done({"playlist": pid})

        return False

    def _done(self, value: dict) -> dict:
        self.ctx.publish("playlists", {"op": "changed"}, source=self)
        return value

    def on_event(self, topic, payload):
        if topic == "playlists":
            return {"event": "playlists_changed"}
        if topic == "fs":
            self._library = None  # next "library" fetch rescans
            return {"event": "restore" if payload.get("resync") else "library_changed"}
        return None
