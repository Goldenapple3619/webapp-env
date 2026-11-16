"""
The terminal.

Anything that is only the shell's own builtins answers immediately. A line that may run a real program (a compiler, an
interpreter, a binary, a script) is handed to a small worker pool and answers with {"pending": job}; when it finishes the
result arrives as an `exec_done` event. The websocket is shared by every app of the user, so a ten second compile must
never sit on it: Explorer, Code and the desktop keep working while it runs.
"""
import secrets
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from traceback import format_exc

from src import App, AppError, FsError, UserFS
from src.common.runner import shared_runner
from src.common.shell import RED, RESET, Shell, Word, tokenize
from src.config import Config

MUTATING = {"rm", "mkdir", "touch", "mv", "cp", "rmdir", "chmod"}

_pool = ThreadPoolExecutor(max_workers=Config.exec_workers, thread_name_prefix="exec")
_lock = threading.Lock()
_running = defaultdict(int)


class TerminalApp(App):
    topics = ("term",)

    def __init__(self, ctx):
        super().__init__(ctx)
        self.token = secrets.token_hex(8)
        self.job = None
        self.runner = shared_runner()
        self.shell = Shell(UserFS(ctx.root_path), ctx.username, runner=self.runner, user_id=ctx.user_id, audit=self._audit)

    def _audit(self, record: dict) -> None:
        """One row per real program run: who ran what, how it ended. Best effort: never breaks a command."""
        if self.ctx.db is None:
            return
        try:
            self.ctx.db.execute(
                "INSERT INTO exec_log (user_id, tool, argv, status, outcome, duration_ms) VALUES (%s, %s, %s, %s, %s, %s)",
                (self.ctx.user_id, record["tool"][:120], record["argv"], record["status"], record["outcome"], record["ms"]))
        except Exception:
            pass

    @staticmethod
    def _payload(result) -> dict:
        return {"output": result.output, "status": result.status, "clear": result.clear,
                "actions": [a for a in result.actions if a["type"] != "fs_changed"]}

    def _announce_changes(self, line: str, result) -> None:
        for action in result.actions:
            if action["type"] == "fs_changed":
                self.ctx.publish("fs", {"op": "shell", "dirs": action["dirs"], "files": action["files"]}, source=self)
        touches = result.external
        if not touches:
            try:
                touches = any(isinstance(t, Word) and str(t) in MUTATING for t in tokenize(line))
            except ValueError:
                touches = False
        if touches:  # a program or a command may have changed files anywhere: have every explorer look again
            self.ctx.publish("fs", {"op": "shell", "dirs": [], "files": [], "resync": True}, source=self)

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "prompt":
            return {"type": "prompt", "cwd": self.shell.cwd, "user": self.ctx.username, "running": self.job is not None}
        if fetch_type == "complete":
            return {"type": "complete", "matches": self.shell.complete(str(kwargs.get("line", ""))[:2000])}
        if fetch_type == "history":
            return {"type": "history", "history": self.shell.history}
        if fetch_type == "tools":
            catalog = self.runner.tools(force=bool(kwargs.get("refresh")))
            return {"type": "tools", "enabled": self.runner.enabled, "sandbox": catalog.get("sandbox"),
                    "tools": catalog.get("tools", []), "error": catalog.get("error")}
        return None

    def write(self, update_type, **kwargs):
        if update_type == "exec":
            line = kwargs.get("line")
            if not isinstance(line, str) or len(line) > 4000:
                raise AppError("invalid_command")
            if self.job is not None:
                raise AppError("busy", "a program is still running (Ctrl+C stops it)")

            if not self.shell.needs_runner(line):
                result = self.shell.run(line)
                self._announce_changes(line, result)
                return {**self._payload(result), "cwd": self.shell.cwd}

            uid = self.ctx.user_id
            with _lock:
                if _running[uid] >= Config.exec_per_user:
                    raise AppError("busy", f"at most {Config.exec_per_user} programs can run at the same time")
                _running[uid] += 1
            job = {"id": secrets.token_hex(6), "cancel": threading.Event()}
            self.job = job
            try:
                _pool.submit(self._work, job, line)
            except RuntimeError:  # pool shut down
                self.job = None
                with _lock:
                    _running[uid] -= 1
                raise AppError("unavailable", "the server is shutting down")
            return {"pending": job["id"], "cwd": self.shell.cwd}

        if update_type == "kill":
            job = self.job
            if job is None:
                return {"killed": False}
            job["cancel"].set()
            current = self.shell.current_job
            if current:
                self.runner.cancel(current)
            return {"killed": True}

        if update_type == "set_cwd":  # the code editor's terminal follows the folder being browsed
            try:
                target = self.shell.p(str(kwargs.get("path", "/")))
                if self.shell._fs_stat(target)["type"] == "folder":
                    self.shell.cwd = target
            except FsError:
                pass
            return {"cwd": self.shell.cwd}

        return False

    def _work(self, job: dict, line: str) -> None:
        uid = self.ctx.user_id
        try:
            try:
                result = self.shell.run(line, cancel=job["cancel"])
                self._announce_changes(line, result)
                done = self._payload(result)
            except Exception:
                print(format_exc(), flush=True)
                done = {"output": f"{RED}internal error while running the command{RESET}\n", "status": 1, "clear": False, "actions": []}
        finally:
            self.job = None  # before announcing: the client may send its next line the moment it sees the result
            with _lock:
                _running[uid] -= 1
        if not self.closed:
            self.ctx.publish("term", {"token": self.token, "job": job["id"], "done": {**done, "cwd": self.shell.cwd}})

    def on_event(self, topic, payload):
        if topic == "term" and payload.get("token") == self.token:
            return {"event": "exec_done", "job": payload["job"], **payload["done"]}
        return None

    def close(self):
        super().close()
        job = self.job
        if job is not None:  # window closed or connection lost: do not leave a program running for nobody
            job["cancel"].set()
            current = self.shell.current_job
            if current:
                self.runner.cancel(current)
