"""
Everything that touches a user's files goes through UserFS, so there is exactly one place that
decides what "inside the user's root" means. Apps (explorer, code editor, terminal, music) are
thin wrappers around it.
"""
import os
import posixpath
import shutil
import tempfile
from os.path import join as join_path

from ..network.wsserver import AppError

MAX_TEXT_BYTES = 2 * 1024 * 1024
PROTECTED_TOP_LEVEL = {"documents", "desktop", "music", "videos", "downloads", "pictures"}

class FsError(AppError):
    pass

def version_of(st: os.stat_result) -> str:
    return f"{st.st_mtime_ns}-{st.st_size}-{st.st_ino}"

def valid_name(name) -> bool:
    return (
        isinstance(name, str)
        and 0 < len(name) <= 255
        and name not in (".", "..")
        and not any(c in name for c in ("/", "\\", "\0"))
    )


def normalize(relative) -> str:
    text = str(relative if relative is not None else "/")
    if "\0" in text:
        raise FsError("invalid_path")
    parts: list[str] = []
    for part in text.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return "/" + "/".join(parts)


class UserFS:
    def __init__(self, root: str):
        self.root = os.path.realpath(root)

    def resolve(self, relative) -> str:
        clean = normalize(relative)
        target = os.path.realpath(join_path(self.root, clean.lstrip("/")))
        if target != self.root and not target.startswith(self.root + os.sep):
            raise FsError("not_found")
        return target

    def rel(self, absolute: str) -> str:
        if absolute == self.root:
            return "/"
        return "/" + os.path.relpath(absolute, self.root).replace(os.sep, "/")

    def _existing(self, relative) -> str:
        target = self.resolve(relative)
        if not os.path.lexists(target):
            raise FsError("not_found")
        return target

    def _guard_top_level(self, target: str) -> None:
        if target == self.root:
            raise FsError("forbidden", "the root cannot be modified")
        parts = self.rel(target).strip("/").split("/")
        if len(parts) == 1 and parts[0] in PROTECTED_TOP_LEVEL:
            raise FsError("forbidden", "system folders cannot be renamed or deleted")

    @staticmethod
    def _entry(path: str, name: str, st: os.stat_result, relative: str) -> dict:
        is_dir = os.path.isdir(path)
        return {
            "name": name,
            "path": relative,
            "icon": None,
            "type": "folder" if is_dir else "file",
            "ext": "" if is_dir else os.path.splitext(name)[1].lower().lstrip("."),
            "size": 0 if is_dir else st.st_size,
            "hidden": name.startswith("."),
            "creation_date": st.st_ctime,
            "modification_date": st.st_mtime,
        }

    def listdir(self, relative="/") -> dict:
        target = self._existing(relative)
        if not os.path.isdir(target):
            raise FsError("not_dir")
        here = self.rel(target)
        content = []
        with os.scandir(target) as it:
            for item in it:
                if item.name.startswith(".upload-") and item.name.endswith(".part"):
                    continue  # in-flight HTTP upload
                try:
                    content.append(self._entry(item.path, item.name, item.stat(), posixpath.join(here, item.name)))
                except OSError:
                    continue
        content.sort(key=lambda e: (e["type"] != "folder", e["name"].lower()))
        return {"type": "listdir", "fetched": here, "content": content}

    def stat(self, relative) -> dict:
        target = self._existing(relative)
        return self._entry(target, os.path.basename(target) or "/", os.stat(target), self.rel(target))

    def read_text(self, relative, limit: int = MAX_TEXT_BYTES) -> dict:
        target = self._existing(relative)
        if os.path.isdir(target):
            raise FsError("is_dir")
        st = os.stat(target)
        if st.st_size > limit:
            raise FsError("too_large", size=st.st_size, limit=limit)
        with open(target, "rb") as fp:
            raw = fp.read()
        if b"\0" in raw[:8192]:
            raise FsError("binary")
        try:
            text, encoding = raw.decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            text, encoding = raw.decode("latin-1"), "latin-1"
        eol = "crlf" if "\r\n" in text else "lf"
        return {
            "path": self.rel(target),
            "content": text.replace("\r\n", "\n") if eol == "crlf" else text,
            "encoding": encoding,
            "eol": eol,
            "size": st.st_size,
            "mtime": version_of(st),
        }

    def search(self, relative, query: str, limit: int = 200, max_visited: int = 20000) -> dict:
        base = self._existing(relative)
        needle = str(query).lower().strip()
        if not needle:
            raise FsError("invalid_query")
        found, visited = [], 0
        for current, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not os.path.islink(join_path(current, d))]
            for name in dirs + files:
                visited += 1
                if needle in name.lower():
                    full = join_path(current, name)
                    try:
                        found.append(self._entry(full, name, os.stat(full), self.rel(full)))
                    except OSError:
                        pass
                if len(found) >= limit or visited >= max_visited:
                    return {"type": "search", "content": found, "truncated": True}
        return {"type": "search", "content": found, "truncated": False}

    def _new_child(self, parent_rel, name) -> str:
        if not valid_name(name):
            raise FsError("invalid_name")
        parent = self._existing(parent_rel)
        if not os.path.isdir(parent):
            raise FsError("not_dir")
        target = join_path(parent, name)
        if os.path.lexists(target):
            raise FsError("exists")
        return target

    def mkdir(self, parent_rel, name) -> str:
        target = self._new_child(parent_rel, name)
        os.mkdir(target)
        return self.rel(target)

    def mkfile(self, parent_rel, name) -> str:
        target = self._new_child(parent_rel, name)
        with open(target, "xb"):
            pass
        return self.rel(target)

    def rename(self, relative, new_name) -> str:
        target = self._existing(relative)
        self._guard_top_level(target)
        if not valid_name(new_name):
            raise FsError("invalid_name")
        dest = join_path(os.path.dirname(target), new_name)
        if os.path.lexists(dest) and os.path.realpath(dest) != target:
            raise FsError("exists")
        os.rename(target, dest)
        return self.rel(dest)

    def _dest_dir(self, dest_rel) -> str:
        dest = self._existing(dest_rel)
        if not os.path.isdir(dest):
            raise FsError("not_dir")
        return dest

    def move(self, relatives, dest_rel) -> list[str]:
        dest = self._dest_dir(dest_rel)
        out = []
        for relative in relatives:
            source = self._existing(relative)
            self._guard_top_level(source)
            if dest == source or dest.startswith(source + os.sep):
                raise FsError("invalid_move", "cannot move a folder into itself")
            target = join_path(dest, os.path.basename(source))
            if os.path.lexists(target):
                if os.path.realpath(target) == source:
                    out.append(self.rel(source))
                    continue
                raise FsError("exists", name=os.path.basename(source))
            shutil.move(source, target)
            out.append(self.rel(target))
        return out

    def copy(self, relatives, dest_rel) -> list[str]:
        dest = self._dest_dir(dest_rel)
        out = []
        for relative in relatives:
            source = self._existing(relative)
            if source == self.root:
                raise FsError("forbidden")
            if os.path.isdir(source) and (dest == source or dest.startswith(source + os.sep)):
                raise FsError("invalid_copy", "cannot copy a folder into itself")
            name = os.path.basename(source)
            target, n = join_path(dest, name), 0
            while os.path.lexists(target):
                n += 1
                stem, ext = os.path.splitext(name) if os.path.isfile(source) else (name, "")
                target = join_path(dest, f"{stem} (copy{'' if n == 1 else f' {n}'}){ext}")
            if os.path.isdir(source):
                shutil.copytree(source, target, symlinks=True)
            else:
                shutil.copy2(source, target)
            out.append(self.rel(target))
        return out

    def delete(self, relative) -> str:
        target = self._existing(relative)
        self._guard_top_level(target)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
        return self.rel(target)

    def write_text(self, relative, content, *, base_mtime=None, force=False, eol="lf", create=False) -> dict:
        if not isinstance(content, str):
            raise FsError("invalid_content")
        data = (content.replace("\n", "\r\n") if eol == "crlf" else content).encode("utf-8")
        if len(data) > MAX_TEXT_BYTES * 4:
            raise FsError("too_large")
        target = self.resolve(relative)
        if os.path.isdir(target):
            raise FsError("is_dir")
        exists = os.path.lexists(target)
        if not exists and not create:
            raise FsError("not_found")
        if not os.path.isdir(os.path.dirname(target)):
            raise FsError("not_found")
        if exists and not force and base_mtime is not None:
            current = version_of(os.stat(target))
            if str(base_mtime) != current:
                raise FsError("conflict", "the file changed on disk", mtime=current)
        mode = os.stat(target).st_mode & 0o777 if exists else 0o644
        fd, tmp = tempfile.mkstemp(prefix=".save-", dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            os.chmod(tmp, mode)
            os.replace(tmp, target)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        st = os.stat(target)
        return {"path": self.rel(target), "size": st.st_size, "mtime": version_of(st), "created": not exists}

    def resolve_rel(self, relative) -> str:
        return normalize(relative)
