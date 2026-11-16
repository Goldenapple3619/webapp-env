"""
/virtual: a read-only mount, present for every user, that holds the *executables*.

    /virtual/sh        the virtual shell itself (runs inside the gateway, only ever sees the user's own files)
    /virtual/<tool>    real tools (gcc, python3, ...) executed by the sandbox runner - listed only when one is configured

It is not a directory on disk. `ls`, `cat`, `stat` and the file explorer see it through this class; `PATH=/virtual` is how
the shell finds commands; nothing can be created, renamed or written below it (UserFS refuses, with "read_only").
"""
from .userfs import FsError, normalize

ROOT = "/virtual"
SHELL_NAME = "sh"

SHELL_DOC = """#!/virtual/sh
# The virtual shell (built in).
#
#   sh -c 'command'        run one command line
#   sh script [args...]    run a script ($0 $1 ... $# $@ $? and NAME=value work)
#   ./script               a script starting with "#!/virtual/sh" and marked executable (chmod +x)
#
# It runs inside the server process, can only see your own files, and has no way out of them.
# Real tools (compilers, interpreters) are listed next to it and run in an isolated sandbox instead.
"""


def is_virtual_path(path) -> bool:
    clean = normalize(path)
    return clean == ROOT or clean.startswith(ROOT + "/")


class VirtualFS:
    def __init__(self, runner):
        self.runner = runner

    def _tools(self) -> list:
        return [t for t in self.runner.tools().get("tools", []) if t.get("name") != SHELL_NAME]

    def lookup(self, name: str):
        """-> {"name", "kind": "shell" | "tool", "description", ...} or None."""
        if name == SHELL_NAME:
            return {"name": SHELL_NAME, "kind": "shell", "description": "the virtual shell"}
        for tool in self._tools():
            if tool["name"] == name:
                return {**tool, "kind": "tool"}
        return None

    def names(self) -> list:
        return [SHELL_NAME] + sorted(t["name"] for t in self._tools())

    def describe(self, name: str) -> str:
        entry = self.lookup(name)
        if entry is None:
            raise FsError("not_found")
        if entry["kind"] == "shell":
            return SHELL_DOC
        limits = entry.get("limits") or {}
        lines = [f"# {entry['name']} - {entry.get('description', 'sandboxed tool')}"]
        if entry.get("version"):
            lines.append(f"# version: {entry['version']}")
        lines += ["#", "# A real program, run by the sandbox runner (not by this server):",
                  "#   - your files appear under /work inside it (your current folder is its working directory)",
                  "#   - no network, no access to anything but your files, a private /tmp that vanishes afterwards"]
        if limits:
            lines.append("#   - limits: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in limits.items()))
        return "\n".join(lines) + "\n"

    @staticmethod
    def _entry(name: str, size: int, folder=False) -> dict:
        path = ROOT if name == "" else f"{ROOT}/{name}"
        return {"name": name or "virtual", "path": path, "icon": None, "type": "folder" if folder else "file",
                "ext": "", "size": 0 if folder else size, "hidden": False, "executable": not folder,
                "creation_date": 0, "modification_date": 0, "virtual": True}

    def listdir(self, path: str = ROOT) -> dict:
        if normalize(path) != ROOT:
            raise FsError("not_dir" if self.lookup(normalize(path)[len(ROOT) + 1:]) else "not_found")
        content = [self._entry(n, len(self.describe(n))) for n in self.names()]
        return {"type": "listdir", "fetched": ROOT, "content": content}

    def stat(self, path: str) -> dict:
        clean = normalize(path)
        if clean == ROOT:
            return self._entry("", 0, folder=True)
        name = clean[len(ROOT) + 1:]
        if "/" in name or self.lookup(name) is None:
            raise FsError("not_found")
        return self._entry(name, len(self.describe(name)))

    def read_text(self, path: str) -> dict:
        clean = normalize(path)
        if clean == ROOT:
            raise FsError("is_dir")
        name = clean[len(ROOT) + 1:]
        text = self.describe(name) if "/" not in name else None
        if text is None:
            raise FsError("not_found")
        return {"path": clean, "content": text, "encoding": "utf-8", "eol": "lf", "size": len(text), "mtime": "virtual",
                "readonly": True}
