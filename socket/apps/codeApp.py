import ast
import json
import os

from src import AppError, FsApp

MAX_STATE = 64 * 1024

class CodeApp(FsApp):
    def __init__(self, ctx):
        super().__init__(ctx)
        self.state_file = self.join_path("code", "state.json")

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "read":
            return {"type": "read", **self.fs.read_text(kwargs.get("path"))}
        if fetch_type == "lint":
            return {"type": "lint", "problems": self.lint(kwargs.get("language"), kwargs.get("content", ""))}
        if fetch_type == "state":
            try:
                with open(self.state_file, "r", encoding="utf-8") as fp:
                    return {"type": "state", "state": json.load(fp)}
            except (OSError, ValueError):
                return {"type": "state", "state": {}}
        return super().fetch(fetch_type, **kwargs)

    def write(self, update_type, **kwargs):
        if update_type == "save":
            result = self.fs.write_text(
                kwargs.get("path"), kwargs.get("content"),
                base_mtime=kwargs.get("base_mtime"), force=bool(kwargs.get("force")),
                eol=kwargs.get("eol", "lf"), create=bool(kwargs.get("create")),
            )
            parent = os.path.dirname(result["path"]) or "/"
            self.changed("save", dirs=[parent] if result["created"] else [], files=[result["path"]])
            return result
        if update_type == "state":
            state = kwargs.get("state")
            raw = json.dumps(state)
            if not isinstance(state, dict) or len(raw) > MAX_STATE:
                raise AppError("invalid_state")
            os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
            with open(self.state_file, "w", encoding="utf-8") as fp:
                fp.write(raw)
            return True
        return super().write(update_type, **kwargs)

    @staticmethod
    def lint(language, content) -> list:
        if not isinstance(content, str) or len(content) > 1_000_000:
            return []
        try:
            if language == "python":
                ast.parse(content)
            elif language == "json":
                json.loads(content)
        except SyntaxError as exc:
            return [{"severity": "error", "line": exc.lineno or 1, "col": exc.offset or 1, "message": exc.msg}]
        except json.JSONDecodeError as exc:
            return [{"severity": "error", "line": exc.lineno, "col": exc.colno, "message": exc.msg}]
        return []
