from src import App, AppError, FsError, UserFS
from src.common.shell import Shell

class TerminalApp(App):
    topics = ()

    def __init__(self, ctx):
        super().__init__(ctx)
        self.shell = Shell(UserFS(ctx.root_path), ctx.username)

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "prompt":
            return {"type": "prompt", "cwd": self.shell.cwd, "user": self.ctx.username}
        if fetch_type == "complete":
            return {"type": "complete", "matches": self.shell.complete(str(kwargs.get("line", ""))[:2000])}
        if fetch_type == "history":
            return {"type": "history", "history": self.shell.history}
        return None

    def write(self, update_type, **kwargs):
        if update_type == "exec":

            line = kwargs.get("line")

            if not isinstance(line, str) or len(line) > 4000:
                raise AppError("invalid_command")

            result = self.shell.run(line)

            for action in result.actions:
                if action["type"] == "fs_changed":
                    self.ctx.publish("fs", {"op": "shell", "dirs": action["dirs"], "files": action["files"]}, source=self)

            for rm_cmd in ("rm", "mkdir", "touch", "mv", "cp", "rmdir"):
                if line.split(None, 1)[:1] == [rm_cmd]:
                    self.ctx.publish("fs", {"op": "shell", "dirs": [self.shell.cwd], "files": []}, source=self)

            return {"output": result.output, "status": result.status, "clear": result.clear,
                    "actions": [a for a in result.actions if a["type"] != "fs_changed"], "cwd": self.shell.cwd}

        if update_type == "set_cwd":
            try:
                self.shell.run(f"cd '{str(kwargs.get('path', '/')).replace(chr(39), '')}'")
            except FsError:
                pass
            return {"cwd": self.shell.cwd}

        return False
