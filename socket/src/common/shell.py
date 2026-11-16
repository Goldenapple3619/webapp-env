import fnmatch
import posixpath
import re
import secrets
import shlex
import threading
import time
from dataclasses import dataclass, field

from .runner import DisabledRunner, RunnerError
from .userfs import FsError, UserFS, normalize
from .virtualfs import ROOT as VIRTUAL_ROOT, SHELL_NAME, VirtualFS, is_virtual_path

MAX_OUTPUT = 256 * 1024
MAX_SCRIPT = 256 * 1024
MAX_STDIN = 1024 * 1024
MAX_DEPTH = 6
COMMAND_BUDGET = 2000          # commands one run() may execute, scripts included: a script cannot loop the server forever
BLUE, GREEN, DIM, RED, RESET = "\x1b[1;34m", "\x1b[32m", "\x1b[2m", "\x1b[31m", "\x1b[0m"
AUDIO = {"mp3", "ogg", "wav", "flac", "m4a", "aac", "opus"}
SANDBOX_ROOT = "/work"         # where a real tool sees the user's files
# names we recognise even when no runner offers them, so the error can say why instead of "command not found"
KNOWN_TOOLS = {"gcc", "g++", "cc", "c++", "make", "python", "python3", "pip", "node", "npm", "bash", "perl", "ruby", "go", "rustc", "cargo"}

HELP = """Built-in commands (virtual shell - nothing here can leave your own files):
  ls [-l] [-a] [path]    cd [path]       pwd          tree [-L n] [path]
  cat file...            head/tail [-n N] [file]       wc [-l|-w|-c] [file]
  mkdir [-p] dir...      touch file...   rm [-r] [-f] path...      rmdir dir...
  cp [-r] src dst        mv src dst      stat path    du [-h] [path]    chmod +x|-x file...
  find [path] -name PAT  grep [-i] [-n] [-r] PAT [file...]         sort [-r] / uniq
  echo text              whoami  hostname  date  uname  env  history  clear
  export/unset/set       NAME=value assigns, $NAME / ${NAME} / $? / $1.. / $# / $@ expand
  which/type name        where a command comes from       tools   list the real tools
  open <path>            open a file/folder with the matching app
  play <file>            play a music file      code <file>   edit a file
Pipes (cmd | cmd), redirects (> >> <), ';' '&&' '||', wildcards (* ? [..]) and # comments work.
Tab completes, Up/Down = history, Ctrl+C stops a running program.

/virtual holds the executables (PATH=/virtual):
  /virtual/sh            this shell, as a program:  sh -c 'cmd'   |   sh script.sh [args]   |   ./script (#!/virtual/sh + chmod +x)
  /virtual/<tool>        real tools such as gcc or python3, run in an isolated sandbox (see: tools)
                         inside a tool your files live under /work and the current folder is its working directory"""

@dataclass
class Result:
    output: str = ""
    status: int = 0
    clear: bool = False
    actions: list = field(default_factory=list)
    external: bool = False     # a real tool ran (so files may have changed anywhere)

OPERATOR_CHARS = "|&;<>"
VALID_OPERATORS = {"|", "||", "&&", ";", ">", ">>", "<"}
_VAR = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|([0-9?#@*$]))")
_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]{0,63})=")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_ATTACHED = re.compile(r"^(-[A-Za-z]|--[A-Za-z][A-Za-z0-9-]*=)(/.*)$")
_SANDBOX_PATH = re.compile(r"(?<![\w/.-])" + SANDBOX_ROOT + r"(?:/|(?![\w.-]))")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]")


class Op(str):
    """An UNQUOTED shell operator. A quoted ">" or "|" is ordinary text, so it is a plain str, not an Op."""


class Word(str):
    """A command-line word. `pieces` remembers, per fragment, whether $VARS expand and wildcards act there:
    'a'"$B"$C -> unquoted / double-quoted / unquoted; single quotes and backslashes switch both off."""
    pieces: tuple = ()

    def __new__(cls, text, pieces=()):
        obj = super().__new__(cls, text)
        obj.pieces = tuple(pieces) or ((text, True, True),)
        return obj


def tokenize(line: str) -> list:
    tokens, pieces, run, started, i, n = [], [], [], False, 0, len(line)

    def end_run():
        nonlocal run
        if run:
            pieces.append(("".join(run), True, True))
            run = []

    def flush():
        nonlocal pieces, started
        end_run()
        if started:
            tokens.append(Word("".join(p[0] for p in pieces), pieces))
        pieces, started = [], False

    while i < n:
        ch = line[i]
        if ch.isspace():
            flush()
            i += 1
        elif ch == "#" and not started:
            break                                   # comment to the end of the line
        elif ch in OPERATOR_CHARS:
            flush()
            j = i
            while j < n and line[j] in OPERATOR_CHARS:
                j += 1
            tokens.append(Op(line[i:j]))
            i = j
        elif ch == "'":
            j = line.find("'", i + 1)
            if j < 0:
                raise ValueError("No closing quotation")
            end_run()
            pieces.append((line[i + 1:j], False, False))
            started, i = True, j + 1
        elif ch == '"':
            end_run()
            i, closed, text = i + 1, False, []
            while i < n:
                c = line[i]
                if c == '"':
                    closed, i = True, i + 1
                    break
                if c == "\\" and i + 1 < n and line[i + 1] in '"\\$':
                    if text:
                        pieces.append(("".join(text), True, False))
                        text = []
                    pieces.append((line[i + 1], False, False))
                    i += 2
                    continue
                text.append(c)
                i += 1
            if not closed:
                raise ValueError("No closing quotation")
            if text:
                pieces.append(("".join(text), True, False))
            started = True
        elif ch == "\\":
            if i + 1 >= n:
                raise ValueError("No escaped character")
            end_run()
            pieces.append((line[i + 1], False, False))
            started, i = True, i + 2
        else:
            run.append(ch)
            started, i = True, i + 1
    flush()
    return tokens


class CmdError(Exception):
    def __init__(self, message, status=1, output=""):
        super().__init__(message)
        self.status = status
        self.output = output


class Shell:
    def __init__(self, fs: UserFS, username: str, *, runner=None, user_id=None, audit=None):
        self.fs = fs
        self.username = username
        self.user_id = user_id
        self.runner = runner or DisabledRunner()
        self.vfs = VirtualFS(self.runner)
        self.audit = audit                     # optional callable(dict): one record per real program run
        self.cwd = "/"
        self.history: list[str] = []
        self.vars: dict[str, str] = {"PATH": VIRTUAL_ROOT}
        self.exported: set[str] = set()
        self.argv: list[str] = [SHELL_NAME]
        self.errexit = False
        self.depth = 0
        self.cancel = threading.Event()
        self.budget = [COMMAND_BUDGET]
        self.current_job = None                # id of the program running right now (so it can be stopped)
        self._exit = None
        self._ran_external = False
        self._side: list[str] = []
        self._actions: list = []
        self._clear = False
        self.commands = {n[4:]: getattr(self, n) for n in dir(self) if n.startswith("cmd_")}
        self.commands["."] = self.cmd_source

    def p(self, arg: str) -> str:
        if arg == "~" or arg.startswith("~/"):
            arg = "/" + arg[1:].lstrip("/")
        return normalize(arg if arg.startswith("/") else posixpath.join(self.cwd, arg))

    def _fs_stat(self, path):
        return self.vfs.stat(path) if is_virtual_path(path) else self.fs.stat(path)

    def _fs_list(self, path):
        return self.vfs.listdir(path) if is_virtual_path(path) else self.fs.listdir(path)

    def _fs_read(self, path, limit=4 * 1024 * 1024):
        return self.vfs.read_text(path) if is_virtual_path(path) else self.fs.read_text(path, limit=limit)

    def _var(self, name: str) -> str:
        if name == "?":
            return self.vars.get("?", "0")
        if name == "#":
            return str(len(self.argv) - 1)
        if name in ("@", "*"):
            return " ".join(self.argv[1:])
        if name == "$":
            return "1"
        if name.isdigit():
            idx = int(name)
            return self.argv[idx] if idx < len(self.argv) else ""
        base = {"HOME": "/", "USER": self.username, "PWD": self.cwd, "SHELL": VIRTUAL_ROOT + "/" + SHELL_NAME}
        if name in self.vars:
            return self.vars[name]
        return base.get(name, "")

    def expand(self, text: str) -> str:
        return _VAR.sub(lambda m: self._var(m.group(1) or m.group(2) or m.group(3)), text)

    def expand_word(self, word) -> str:
        if not isinstance(word, Word):
            return self.expand(str(word))
        return "".join(self.expand(t) if expandable else t for t, expandable, _ in word.pieces)

    def _glob_pattern(self, word: Word):
        """The expanded word as an fnmatch pattern (wildcards only where they were typed unquoted), or None."""
        out, active = [], False
        for text, expandable, globbing in word.pieces:
            text = self.expand(text) if expandable else text
            if globbing and any(c in text for c in "*?["):
                active = True
                out.append(text)
            else:
                out.append(text.replace("[", "[[]").replace("*", "[*]").replace("?", "[?]"))
        return "".join(out) if active else None

    def _glob(self, pattern: str) -> list:
        join = lambda prefix, name: name if prefix == "" else (prefix + name if prefix.endswith("/") else prefix + "/" + name)
        segments = [seg for seg in pattern.split("/") if seg]
        found = ["/" if pattern.startswith("/") else ""]
        for idx, seg in enumerate(segments):
            last, nxt = idx == len(segments) - 1, []
            for prefix in found:
                if not any(c in seg for c in "*?["):
                    nxt.append(join(prefix, seg))
                    continue
                try:
                    entries = self._fs_list(self.p(prefix) if prefix else self.cwd)["content"]
                except FsError:
                    continue
                for e in entries:
                    if e["hidden"] and not seg.startswith("."):
                        continue
                    if (last or e["type"] == "folder") and fnmatch.fnmatchcase(e["name"], seg):
                        nxt.append(join(prefix, e["name"]))
            found = nxt[:2000]
        return sorted(c for c in found if self._exists(self.p(c)))

    def argv_of(self, words) -> list:
        out = []
        for word in words:
            text = self.expand_word(word)
            pattern = self._glob_pattern(word) if isinstance(word, Word) else None
            matches = self._glob(pattern) if pattern else []
            out.extend(matches if matches else [text])
        return out

    @staticmethod
    def flags(args, spec="", valued=""):
        on, vals, rest, i = set(), {}, [], 0
        while i < len(args):
            a = args[i]
            if a == "--":
                rest += args[i + 1:]
                break
            if a.startswith("-") and len(a) > 1 and not a[1:].isdigit():
                for j, ch in enumerate(a[1:]):
                    if ch in valued:
                        vals[ch] = a[j + 2:] or (args[i + 1] if i + 1 < len(args) else "")
                        if not a[j + 2:]:
                            i += 1
                        break
                    if ch not in spec:
                        raise CmdError(f"invalid option -- '{ch}'")
                    on.add(ch)
            else:
                rest.append(a)
            i += 1
        return on, vals, rest

    def read(self, path: str) -> str:
        return self._fs_read(self.p(path))["content"]

    def inputs(self, files, stdin):
        return "".join(self.read(f) for f in files) if files else (stdin or "")

    def _check(self):
        if self.cancel.is_set():
            raise CmdError("interrupted", 130)
        self.budget[0] -= 1
        if self.budget[0] < 0:
            raise CmdError(f"too many commands in one run (limit {COMMAND_BUDGET})", 1)

    def _reset(self, cancel=None):
        self._actions, self._clear, self._exit, self._ran_external, self._side = [], False, None, False, []
        self.budget = [COMMAND_BUDGET]
        self.cancel = cancel or threading.Event()

    def run(self, line: str, cancel=None) -> Result:
        self._reset(cancel)
        line = line.strip()
        if not line:
            return Result()
        self.history = (self.history + [line])[-200:]
        text, status = self.execute(line)
        if len(text) > MAX_OUTPUT:
            text = text[:MAX_OUTPUT] + f"\n{DIM}[output truncated]{RESET}\n"
        return Result(text, status, self._clear, self._actions, self._ran_external)

    def execute(self, line: str):
        """One logical command line in the current scope -> (output, status)."""
        try:
            tokens = tokenize(line)
        except ValueError as exc:
            return f"{RED}syntax error: {exc}{RESET}\n", 2
        for tok in tokens:
            if isinstance(tok, Op) and tok not in VALID_OPERATORS:
                hint = " (background jobs are not supported)" if "&" in tok and "&&" not in tok else ""
                return f"{RED}syntax error: unsupported operator '{tok}'{hint}{RESET}\n", 2

        groups, cur, op = [], [], ";"
        for tok in tokens:
            if isinstance(tok, Op) and tok in (";", "&&", "||"):
                groups.append((op, cur))
                cur, op = [], tok
            else:
                cur.append(tok)
        groups.append((op, cur))

        out, status = [], int(self.vars.get("?", "0") or 0)
        for idx, (op, toks) in enumerate(groups):
            if (op == "&&" and status != 0) or (op == "||" and status == 0) or not toks:
                continue
            try:
                self._check()
                text, status = self.pipeline(toks)
            except CmdError as exc:
                text, status = f"{exc.output}{RED}{exc}{RESET}\n" if exc.status == 130 else f"{exc.output}{exc}\n", exc.status
            self.vars["?"] = str(status)
            if text:
                out.append(text)
            if self._exit is not None or self.cancel.is_set():
                break
            following = groups[idx + 1][0] if idx + 1 < len(groups) else ";"
            if self.errexit and status != 0 and following not in ("&&", "||"):
                break                                    # set -e: a failure that nothing handles ends the script
        return "".join(out), status

    def pipeline(self, tokens):
        stages, cur = [], []
        for tok in tokens:
            if isinstance(tok, Op) and tok == "|":
                stages.append(cur)
                cur = []
            else:
                cur.append(tok)
        stages.append(cur)
        self._side = []
        text, status = self._pipeline(stages)
        side, self._side = "".join(self._side), []
        return side + text, status

    def _pipeline(self, stages):
        data, status = None, 0
        for i, stage in enumerate(stages):
            first, last = i == 0, i == len(stages) - 1
            redirect, source = None, None
            if first:
                idx = next((k for k, tok in enumerate(stage) if isinstance(tok, Op) and tok == "<"), None)
                if idx is not None:
                    if idx + 1 >= len(stage) or isinstance(stage[idx + 1], Op):
                        return f"{RED}syntax error: missing input file{RESET}\n", 2
                    source = self.expand_word(stage[idx + 1])
                    stage = stage[:idx] + stage[idx + 2:]
            if last:
                idx = next((k for k, tok in enumerate(stage) if isinstance(tok, Op) and tok in (">>", ">")), None)
                if idx is not None:
                    if idx + 1 >= len(stage) or isinstance(stage[idx + 1], Op):
                        return f"{RED}syntax error: missing redirect target{RESET}\n", 2
                    redirect = (str(stage[idx]), self.expand_word(stage[idx + 1]))
                    stage = stage[:idx] + stage[idx + 2:]
            if any(isinstance(tok, Op) for tok in stage):
                return f"{RED}syntax error: '<' only starts a pipeline, '>' only ends it{RESET}\n", 2
            if source is not None:
                try:
                    data = self._fs_read(self.p(source), limit=MAX_STDIN)["content"]
                except FsError as exc:
                    return f"{source}: {exc.code.replace('_', ' ')}\n", 1

            # leading NAME=value words
            assigns = []
            while stage and isinstance(stage[0], Word) and _ASSIGN.match(stage[0]) and stage[0].pieces[0][1]:
                m = _ASSIGN.match(stage[0])
                assigns.append((m.group(1), self.expand_word(Word(str(stage[0])[m.end():], self._tail_pieces(stage[0], m.end())))))
                stage = stage[1:]
            if not stage:
                for name, value in assigns:
                    self.vars[name] = value
                data, status = "", 0
                continue
            if not stage:
                return f"{RED}syntax error: empty command{RESET}\n", 2

            argv = self.argv_of(stage)
            name, args = argv[0], argv[1:]
            to_terminal = last and not redirect
            try:
                data, status = self.dispatch(name, args, data, tty=to_terminal, merge=to_terminal, temp_env=dict(assigns))
            except CmdError as exc:
                if exc.status == 130:
                    raise
                return (f"{exc.output}{name}: {exc}\n" if str(exc) else exc.output), exc.status
            except FsError as exc:
                return f"{name}: {exc.code.replace('_', ' ')}{(': ' + str(exc)) if str(exc) != exc.code else ''}\n", 1
            except UnicodeError:
                return f"{name}: binary data\n", 1
            if self._exit is not None:
                return data or "", self._exit
            if redirect:
                sym, target = redirect
                if target == "/dev/null":
                    data = ""
                    continue
                path = self.p(target)
                try:
                    old = self.fs.read_text(path)["content"] if sym == ">>" else ""
                except FsError as exc:
                    old = "" if exc.code == "not_found" else None
                    if old is None:
                        return f"{name}: {exc.code}\n", 1
                try:
                    self.fs.write_text(path, old + (data or ""), create=True)
                except FsError as exc:
                    return f"{name}: {target}: {exc.code.replace('_', ' ')}\n", 1
                self._actions.append({"type": "fs_changed", "dirs": [posixpath.dirname(path) or "/"], "files": [path]})
                data = ""
        return data or "", status

    @staticmethod
    def _tail_pieces(word: Word, offset: int):
        """The pieces of `word` after its first `offset` characters (what follows NAME=)."""
        out, seen = [], 0
        for text, expandable, globbing in word.pieces:
            if seen + len(text) <= offset:
                seen += len(text)
                continue
            out.append((text[max(0, offset - seen):], expandable, False))
            seen += len(text)
        return out

    def _search_path(self, name: str):
        for folder in (self.vars.get("PATH") or VIRTUAL_ROOT).split(":"):
            if not folder.startswith("/"):
                continue
            path = self.p(folder.rstrip("/") + "/" + name)
            if is_virtual_path(path):
                entry = self.vfs.lookup(name) if normalize(folder) == VIRTUAL_ROOT else None
                if entry:
                    return ("virtual", entry)
            else:
                try:
                    if self.fs.stat(path)["executable"]:
                        return ("file", path)
                except FsError:
                    pass
        return None

    def resolve(self, name: str):
        """-> ("builtin", fn) | ("virtual", entry) | ("file", path) | None."""
        if "/" in name:
            path = self.p(name)
            if is_virtual_path(path):
                entry = self.vfs.lookup(path[len(VIRTUAL_ROOT) + 1:]) if path != VIRTUAL_ROOT else None
                return ("virtual", entry) if entry else None
            try:
                return ("file", path) if self.fs.stat(path)["type"] == "file" else None
            except FsError:
                return None
        if name in self.commands:
            return ("builtin", self.commands[name])
        return self._search_path(name)

    @staticmethod
    def _dynamic(word) -> bool:
        """A command name only known after expansion ($CC, *.sh): assume it may run something slow."""
        return isinstance(word, Word) and any((expandable and "$" in text) or (globbing and any(c in text for c in "*?["))
                                              for text, expandable, globbing in word.pieces)

    def needs_runner(self, line: str) -> bool:
        """Could this line run something slow (a tool, a script, a binary)? Those run on a worker thread: a compile
        must not freeze the websocket that every other app of the user shares. Pure builtins stay synchronous."""
        try:
            tokens = tokenize(line)
        except ValueError:
            return False
        stage, stages = [], []
        for tok in tokens:
            if isinstance(tok, Op) and tok in ("|", "||", "&&", ";"):
                stages.append(stage)
                stage = []
            elif not isinstance(tok, Op) or tok not in (">", ">>", "<"):
                stage.append(tok)
        stages.append(stage)
        for words in stages:
            words = [w for w in words if not (isinstance(w, Word) and _ASSIGN.match(w))] if words and isinstance(words[0], Word) and _ASSIGN.match(words[0]) else words
            if not words:
                continue
            first = words[0]
            if self._dynamic(first):
                return True
            name = self.expand_word(first)
            if name in ("source", "."):
                return True
            found = self.resolve(name)
            if found and found[0] != "builtin":
                return True
        return False

    def dispatch(self, name, args, stdin, *, tty, merge, temp_env):
        found = self.resolve(name)
        if found is None:
            if "/" not in name and name in KNOWN_TOOLS:
                return f"{name}: not available here (the sandbox that runs real tools is not set up on this server)\n", 127
            return f"{name}: {'No such file or directory' if '/' in name else 'command not found'}\n", 127
        kind, target = found
        if kind == "builtin":
            return target(args, stdin, tty=tty), 0
        if kind == "virtual":
            if target["kind"] == "shell":
                return self._run_sh(args, stdin, f"{VIRTUAL_ROOT}/{SHELL_NAME}")
            return self._run_tool(target["name"], args, stdin, merge, temp_env)
        return self._run_file(target, name, args, stdin, merge, temp_env)

    def _run_file(self, path, shown, args, stdin, merge, temp_env):
        if not self.fs.stat(path)["executable"]:
            return f"{shown}: permission denied (chmod +x {shown})\n", 126
        head = self.fs.peek(path, 256)
        if head.startswith(b"#!"):
            line = head.split(b"\n", 1)[0][2:].decode("utf-8", "replace").strip()
            interp, _, option = line.partition(" ")
            option = option.strip()
            name = None
            if interp.startswith(VIRTUAL_ROOT + "/"):
                name = interp[len(VIRTUAL_ROOT) + 1:]
            elif interp.endswith("/env") and option:         # #!/usr/bin/env python3
                name, option = option.split(None, 1)[0], ""
            entry = self.vfs.lookup(name) if name and "/" not in name else None
            if entry is None:
                return f"{shown}: bad interpreter: {interp or '(none)'}\n", 126
            if entry["kind"] == "shell":
                return self._run_sh([path] + args, stdin, shown)
            return self._run_tool(entry["name"], ([option] if option else []) + [path] + args, stdin, merge, temp_env)
        if head.startswith(b"\x7fELF"):
            return self._call_runner({"kind": "file", "path": path}, shown, args, stdin, merge, temp_env)
        return f"{shown}: cannot execute: not a program or a #! script\n", 126

    def _run_tool(self, tool, args, stdin, merge, temp_env):
        return self._call_runner({"kind": "tool", "tool": tool}, tool, args, stdin, merge, temp_env)

    @staticmethod
    def _to_sandbox(arg: str) -> str:
        """The user thinks in '/documents/a.c'; the tool sees the same file at '/work/documents/a.c'."""
        m = _ATTACHED.match(arg)
        if m:
            return m.group(1) + Shell._to_sandbox(m.group(2))
        if arg.startswith("/") and not is_virtual_path(arg):
            return SANDBOX_ROOT + (arg if arg != "/" else "")
        return arg

    @staticmethod
    def _from_sandbox(text: str) -> str:
        text = _CTRL.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
        return _SANDBOX_PATH.sub("/", text)

    def _call_runner(self, what, shown, args, stdin, merge, temp_env):
        if self.user_id is None or not self.runner.enabled:
            return f"{shown}: not available here (the sandbox that runs real tools is not set up on this server)\n", 127
        if stdin is not None and len(stdin.encode("utf-8", "replace")) > MAX_STDIN:
            return f"{shown}: input too large for a program (limit {MAX_STDIN // 1024} KB)\n", 1
        env = {}
        for key in sorted(self.exported):
            if key in self.vars and key not in ("PATH",):
                env[key] = self.vars[key]
        env.update(temp_env)
        env = {k: v[:1024] for k, v in list(env.items())[:32] if _ENV_NAME.match(k) and "\x00" not in v}
        job = secrets.token_hex(8)
        request = {**what, "job": job, "user": self.user_id, "cwd": self.cwd, "argv": [self._to_sandbox(a) for a in args],
                   "stdin": stdin, "merge": bool(merge), "env": env}
        if what["kind"] == "file":
            request["path"] = what["path"]
        self._check()
        self.current_job, started, outcome = job, time.monotonic(), "error"
        try:
            reply = self.runner.run(request)
            self._ran_external = True
        except RunnerError as exc:
            self._audit(shown, args, 126, started, exc.code)
            note = {"busy": "the sandbox is busy right now, try again in a moment",
                    "denied": "the sandbox refused this server (administrator: check RUNNER_TOKEN)"}.get(exc.code, str(exc))
            return f"{RED}{shown}: {note}{RESET}\n", 126
        finally:
            self.current_job = None
        status = reply.get("status") if isinstance(reply.get("status"), int) else 1
        out, err = self._from_sandbox(str(reply.get("stdout", ""))), self._from_sandbox(str(reply.get("stderr", "")))
        notes = []
        if reply.get("cancelled"):
            outcome, status = "cancelled", 130
            notes.append("interrupted")
        elif reply.get("timed_out"):
            outcome, status = "timeout", 124
            notes.append(f"{shown}: stopped after {reply.get('wall_limit', '?')}s (time limit)")
        elif reply.get("signal"):
            outcome = "signal"
            notes.append(f"{shown}: killed by {reply['signal']}" + (" (probably out of memory)" if reply["signal"] == "SIGKILL" else ""))
        else:
            outcome = "ok" if status == 0 else "exit"
        if reply.get("truncated"):
            notes.append("output truncated by the sandbox")
        self._audit(shown, args, status, started, outcome)
        if err:
            self._side.append(err if err.endswith("\n") else err + "\n")
        if notes:
            self._side.append("".join(f"{RED}[{n}]{RESET}\n" for n in notes))
        if reply.get("cancelled"):
            self.cancel.set()
        return out, status

    def _audit(self, shown, args, status, started, outcome):
        if self.audit:
            try:
                self.audit({"tool": shown, "argv": " ".join(args)[:500], "status": status, "outcome": outcome,
                            "ms": int((time.monotonic() - started) * 1000)})
            except Exception:
                pass

    def _child(self, argv):
        if self.depth >= MAX_DEPTH:
            raise CmdError(f"scripts nested too deeply (limit {MAX_DEPTH})")
        child = Shell(self.fs, self.username, runner=self.runner, user_id=self.user_id, audit=self.audit)
        child.cwd, child.vars, child.exported = self.cwd, dict(self.vars), set(self.exported)
        child.argv, child.depth, child.cancel, child.budget = argv, self.depth + 1, self.cancel, self.budget
        child.vfs = self.vfs
        return child

    def _run_sh(self, args, stdin, shown):
        """/virtual/sh [-e] [-c command [name [args...]] | script [args...]]  (no arguments: read the script from stdin)"""
        errexit, command, rest, i = False, None, [], 0
        while i < len(args):
            a = args[i]
            if a == "-c":
                if i + 1 >= len(args):
                    raise CmdError("-c: option requires an argument", 2)
                command, rest = args[i + 1], args[i + 2:]
                break
            if a == "-e":
                errexit = True
            elif a.startswith("-") and a != "-":
                raise CmdError(f"invalid option -- '{a.lstrip('-')}'", 2)
            else:
                rest = args[i:]
                break
            i += 1
        if command is not None:
            source, argv = command, [rest[0] if rest else shown] + rest[1:]
        elif rest:
            try:
                source = self._fs_read(self.p(rest[0]), limit=MAX_SCRIPT)["content"]
            except FsError as exc:
                return f"{shown}: {rest[0]}: {exc.code.replace('_', ' ')}\n", 127
            argv = rest
        else:
            source, argv = stdin or "", [shown]
        if len(source) > MAX_SCRIPT:
            raise CmdError("script too large", 1)
        child = self._child(argv)
        child.errexit = errexit
        text, status = child._run_script(source)
        self._actions.extend(child._actions)
        self._clear = self._clear or child._clear
        self._ran_external = self._ran_external or child._ran_external
        self._side.extend(child._side)
        return text, status

    def _run_script(self, source: str):
        lines, buf = [], ""
        for raw in source.splitlines()[:5000]:
            trailing = len(raw) - len(raw.rstrip("\\"))
            if trailing % 2 == 1:
                buf += raw[:-1]
                continue
            lines.append(buf + raw)
            buf = ""
        if buf:
            lines.append(buf)
        out, status = [], 0
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                self._check()
            except CmdError as exc:
                out.append(f"{exc}\n")
                status = exc.status
                break
            text, status = self.execute(line)
            if text:
                out.append(text)
            if self._exit is not None:
                return "".join(out), self._exit
            if self.cancel.is_set() or (self.errexit and status != 0):
                break
        return "".join(out), status

    @staticmethod
    def _number(value, default: int, option: str) -> int:
        """An option's numeric argument: a typo is a usage error for the user, never an internal error."""
        if value in (None, ""):
            return default
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise CmdError(f"invalid number for -{option}: '{value}'")
        if number < 0:
            raise CmdError(f"invalid number for -{option}: '{value}' (must not be negative)")
        return number

    def cmd_help(self, args, stdin, tty=True):
        return HELP + "\n"

    def cmd_true(self, args, stdin, tty=True):
        return ""

    def cmd_false(self, args, stdin, tty=True):
        raise CmdError("", 1)

    def cmd_pwd(self, args, stdin, tty=True):
        return self.cwd + "\n"

    def cmd_cd(self, args, stdin, tty=True):
        target = self.p(args[0]) if args else "/"
        if self._fs_stat(target)["type"] != "folder":
            raise CmdError(f"{args[0]}: not a directory")
        self.vars["OLDPWD"], self.cwd = self.cwd, target
        return ""

    def cmd_ls(self, args, stdin, tty=True):
        on, _, paths = self.flags(args, "lah1")
        out = []
        for path in paths or ["."]:
            info = self._fs_stat(self.p(path))
            entries = self._fs_list(self.p(path))["content"] if info["type"] == "folder" else [info]
            if "a" not in on:
                entries = [e for e in entries if not e["hidden"]] if info["type"] == "folder" else entries
            if len(paths) > 1:
                out.append(f"{path}:")
            for e in entries:
                label = e["name"] + ("/" if e["type"] == "folder" else ("*" if e.get("executable") and "l" not in on else ""))
                if tty and e["type"] == "folder":
                    label = f"{BLUE}{label}{RESET}"
                elif tty and e.get("executable"):
                    label = f"{GREEN}{label}{RESET}"
                elif tty and e["ext"] in AUDIO:
                    label = f"{GREEN}{label}{RESET}"
                if "l" in on:
                    when = time.strftime("%b %d %H:%M", time.localtime(e["modification_date"]))
                    size = self.human(e["size"]) if "h" in on else str(e["size"])
                    mode = "d" if e["type"] == "folder" else ("x" if e.get("executable") else "-")
                    out.append(f"{mode} {size:>8} {when} {label}")
                else:
                    out.append(label)
        if "l" in on or not tty or "1" in on:
            return "\n".join(out) + ("\n" if out else "")
        return "  ".join(out) + ("\n" if out else "")

    @staticmethod
    def human(n):
        for unit in ("B", "K", "M", "G"):
            if n < 1024:
                return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
            n /= 1024
        return f"{n:.1f}T"

    def cmd_tree(self, args, stdin, tty=True):
        _, vals, paths = self.flags(args, "", "L")
        depth = self._number(vals.get("L"), 3, "L")
        base = self.p(paths[0] if paths else ".")
        lines, count = [base if base != "/" else "/"], [0]

        def walk(path, prefix, level):
            if level > depth or count[0] > 2000:
                return
            entries = [e for e in self._fs_list(path)["content"] if not e["hidden"]]
            for i, e in enumerate(entries):
                count[0] += 1
                last = i == len(entries) - 1
                name = f"{BLUE}{e['name']}{RESET}" if tty and e["type"] == "folder" else e["name"]
                lines.append(f"{prefix}{'└── ' if last else '├── '}{name}")
                if e["type"] == "folder":
                    walk(e["path"], prefix + ("    " if last else "│   "), level + 1)

        walk(base, "", 1)
        return "\n".join(lines) + "\n"

    def cmd_cat(self, args, stdin, tty=True):
        _, _, files = self.flags(args)
        return self.inputs(files, stdin)

    def _slice(self, args, stdin, head):
        _, vals, files = self.flags(args, "", "n")
        n = self._number(vals.get("n"), 10, "n")
        lines = self.inputs(files, stdin).splitlines(keepends=True)
        return "".join(lines[:n] if head else (lines[-n:] if n else []))

    def cmd_head(self, args, stdin, tty=True):
        return self._slice(args, stdin, True)

    def cmd_tail(self, args, stdin, tty=True):
        return self._slice(args, stdin, False)

    def cmd_wc(self, args, stdin, tty=True):
        on, _, files = self.flags(args, "lwc")
        text = self.inputs(files, stdin)
        counts = {"l": text.count("\n"), "w": len(text.split()), "c": len(text.encode())}
        picked = [counts[k] for k in "lwc" if k in on] or [counts["l"], counts["w"], counts["c"]]
        return " ".join(map(str, picked)) + "\n"

    def cmd_echo(self, args, stdin, tty=True):
        return " ".join(args) + "\n"

    def cmd_mkdir(self, args, stdin, tty=True):
        on, _, dirs = self.flags(args, "p")
        if not dirs:
            raise CmdError("missing operand")
        for d in dirs:
            target = self.p(d)
            if "p" in on:
                built = ""
                for part in [x for x in target.split("/") if x]:
                    parent, built = built or "/", built + "/" + part
                    if not self._exists(built):
                        self.fs.mkdir(parent, part)
            else:
                parent, name = posixpath.split(target)
                self.fs.mkdir(parent or "/", name)
        return ""

    def _exists(self, path):
        try:
            self._fs_stat(path)
            return True
        except FsError:
            return False

    def cmd_touch(self, args, stdin, tty=True):
        _, _, files = self.flags(args)
        if not files:
            raise CmdError("missing operand")
        for f in files:
            if not self._exists(self.p(f)):
                parent, name = posixpath.split(self.p(f))
                self.fs.mkfile(parent or "/", name)
        return ""

    def cmd_rm(self, args, stdin, tty=True):
        on, _, paths = self.flags(args, "rfd")
        if not paths:
            raise CmdError("missing operand")
        for path in paths:
            target = self.p(path)
            try:
                if self._fs_stat(target)["type"] == "folder" and "r" not in on:
                    raise CmdError(f"{path}: is a directory (use -r)")
                self.fs.delete(target)
            except FsError:
                if "f" not in on:
                    raise
        return ""

    def cmd_rmdir(self, args, stdin, tty=True):
        _, _, dirs = self.flags(args)
        for d in dirs:
            if self.fs.listdir(self.p(d))["content"]:
                raise CmdError(f"{d}: directory not empty")
            self.fs.delete(self.p(d))
        return ""

    def _dest(self, args, flag_spec):
        on, _, rest = self.flags(args, flag_spec)
        if len(rest) < 2:
            raise CmdError("missing destination operand")
        return on, [self.p(a) for a in rest[:-1]], self.p(rest[-1])

    def cmd_mv(self, args, stdin, tty=True):
        _, sources, dest = self._dest(args, "f")
        if len(sources) == 1 and not (self._exists(dest) and self.fs.stat(dest)["type"] == "folder"):
            parent, name = posixpath.split(dest)
            if posixpath.dirname(sources[0]) == (parent or "/"):
                self.fs.rename(sources[0], name)
                return ""
            raise CmdError("moving to a new name in another folder: move first, then rename")
        self.fs.move(sources, dest)
        return ""

    def cmd_cp(self, args, stdin, tty=True):
        on, sources, dest = self._dest(args, "rR")
        for s in sources:
            if self.fs.stat(s)["type"] == "folder" and not on & {"r", "R"}:
                raise CmdError(f"{posixpath.basename(s)}: is a directory (use -r)")
        if not (self._exists(dest) and self.fs.stat(dest)["type"] == "folder"):
            raise CmdError("destination must be an existing folder (copies keep their name)")
        self.fs.copy(sources, dest)
        return ""

    def cmd_stat(self, args, stdin, tty=True):
        _, _, paths = self.flags(args)
        out = []
        for path in paths:
            e = self._fs_stat(self.p(path))
            out.append(f"  File: {e['path']}\n  Type: {e['type']}{' (executable)' if e.get('executable') else ''}\n  Size: {e['size']}\n"
                       f"Modify: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(e['modification_date']))}")
        return "\n".join(out) + "\n"

    def cmd_du(self, args, stdin, tty=True):
        on, _, paths = self.flags(args, "h")
        total = 0

        def walk(path):
            nonlocal total
            for e in self.fs.listdir(path)["content"]:
                if e["type"] == "folder":
                    walk(e["path"])
                else:
                    total += e["size"]

        target = self.p(paths[0] if paths else ".")
        if self.fs.stat(target)["type"] == "folder":
            walk(target)
        else:
            total = self.fs.stat(target)["size"]
        return f"{self.human(total) if 'h' in on else total}\t{target}\n"

    def cmd_find(self, args, stdin, tty=True):
        base, pattern, i = ".", "*", 0
        while i < len(args):
            if args[i] == "-name" and i + 1 < len(args):
                pattern, i = args[i + 1], i + 1
            elif not args[i].startswith("-"):
                base = args[i]
            i += 1
        out, seen = [], 0

        def walk(path):
            nonlocal seen
            for e in self.fs.listdir(path)["content"]:
                seen += 1
                if fnmatch.fnmatch(e["name"].lower(), pattern.lower()):
                    out.append(e["path"])
                if e["type"] == "folder" and seen < 20000 and len(out) < 1000:
                    walk(e["path"])

        walk(self.p(base))
        return "\n".join(out) + ("\n" if out else "")

    def cmd_grep(self, args, stdin, tty=True):
        on, _, rest = self.flags(args, "inrE")
        if not rest:
            raise CmdError("missing pattern")
        needle, files = rest[0], rest[1:]
        needle_cmp = needle.lower() if "i" in on else needle
        sources, recursed = [], set()
        if files:
            for f in files:
                target = self.p(f)
                if "r" in on and self.fs.stat(target)["type"] == "folder":
                    stack = [target]
                    while stack:
                        for e in self.fs.listdir(stack.pop())["content"]:
                            if e["type"] == "folder":
                                stack.append(e["path"])
                            else:
                                sources.append(e["path"])
                                recursed.add(e["path"])
                else:
                    sources.append(target)
        else:
            sources = [None]
        out, errors = [], []
        for src in sources:
            try:
                text = stdin or "" if src is None else self.fs.read_text(src)["content"]
            except FsError as exc:
                if exc.code in ("binary", "too_large") or (src in recursed):
                    continue
                errors.append(f"{src}: {exc.code.replace('_', ' ')}")
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if needle_cmp in (line.lower() if "i" in on else line):
                    prefix = (f"{src}:" if len(sources) > 1 else "") + (f"{n}:" if "n" in on else "")
                    out.append(prefix + line)
        matches = "\n".join(out) + ("\n" if out else "")
        if errors:
            raise CmdError("\ngrep: ".join(errors), status=2, output=matches)
        return matches

    def cmd_sort(self, args, stdin, tty=True):
        on, _, files = self.flags(args, "r")
        return "\n".join(sorted(self.inputs(files, stdin).splitlines(), reverse="r" in on)) + "\n"

    def cmd_uniq(self, args, stdin, tty=True):
        out, last = [], object()
        for line in (stdin or "").splitlines():
            if line != last:
                out.append(line)
            last = line
        return "\n".join(out) + ("\n" if out else "")

    def cmd_whoami(self, args, stdin, tty=True):
        return self.username + "\n"

    def cmd_hostname(self, args, stdin, tty=True):
        return "webapp-env\n"

    def cmd_date(self, args, stdin, tty=True):
        return time.strftime("%a %b %d %H:%M:%S %Y") + "\n"

    def cmd_uname(self, args, stdin, tty=True):
        return "WebappEnv virtual shell\n"

    def cmd_env(self, args, stdin, tty=True):
        base = {"HOME": "/", "USER": self.username, "PWD": self.cwd, "PATH": self.vars.get("PATH", VIRTUAL_ROOT),
                "SHELL": f"{VIRTUAL_ROOT}/{SHELL_NAME}"}
        base.update({k: v for k, v in self.vars.items() if k in self.exported and k != "PATH"})
        return "".join(f"{k}={v}\n" for k, v in base.items())

    def cmd_export(self, args, stdin, tty=True):
        if not args:
            return self.cmd_env(args, stdin)
        for arg in args:
            name, eq, value = arg.partition("=")
            if not _ENV_NAME.match(name):
                raise CmdError(f"'{arg}': not a valid identifier")
            if eq:
                self.vars[name] = value
            self.exported.add(name)
        return ""

    def cmd_unset(self, args, stdin, tty=True):
        for name in args:
            self.vars.pop(name, None)
            self.exported.discard(name)
        return ""

    def cmd_set(self, args, stdin, tty=True):
        for arg in args:
            if arg in ("-e", "+e"):
                self.errexit = arg == "-e"
            else:
                raise CmdError(f"unsupported option '{arg}' (only -e / +e)")
        return ""

    def cmd_source(self, args, stdin, tty=True):
        if not args:
            raise CmdError("missing file")
        if self.depth >= MAX_DEPTH:
            raise CmdError(f"scripts nested too deeply (limit {MAX_DEPTH})")
        source = self._fs_read(self.p(args[0]), limit=MAX_SCRIPT)["content"]
        saved, self.argv, self.depth = self.argv, [args[0]] + args[1:], self.depth + 1
        try:
            text, status = self._run_script(source)
        finally:
            self.argv, self.depth = saved, self.depth - 1
        if status:
            raise CmdError(f"{args[0]}: exited with status {status}", status, text)
        return text

    def cmd_which(self, args, stdin, tty=True):
        if not args:
            raise CmdError("missing name")
        out, missing = [], False
        for name in args:
            found = self.resolve(name)
            if not found:
                missing = True
                continue
            kind, target = found
            out.append(f"{name}: shell builtin" if kind == "builtin" else
                       (f"{VIRTUAL_ROOT}/{target['name']}" if kind == "virtual" else target))
        if missing:
            raise CmdError("not found" if len(args) == 1 else "some names were not found", 1, "".join(l + "\n" for l in out))
        return "".join(l + "\n" for l in out)

    cmd_type = cmd_which

    def cmd_tools(self, args, stdin, tty=True):
        catalog = self.runner.tools()
        lines = [f"{GREEN}{VIRTUAL_ROOT}/{SHELL_NAME}{RESET}  the virtual shell (built in)"]
        for tool in sorted(catalog.get("tools", []), key=lambda t: t["name"]):
            if tool["name"] == SHELL_NAME:
                continue
            lines.append(f"{GREEN}{VIRTUAL_ROOT}/{tool['name']}{RESET}  {tool.get('description', '')}" + (f"  {DIM}{tool['version']}{RESET}" if tool.get("version") else ""))
        if not catalog.get("tools"):
            lines.append(f"{DIM}no real tools: {catalog.get('error') or 'the sandbox runner offers none'}{RESET}")
        else:
            lines.append(f"{DIM}sandbox: {catalog.get('sandbox')} - no network, your files are under {SANDBOX_ROOT}, time and memory are limited{RESET}")
        return "\n".join(lines) + "\n"

    def cmd_chmod(self, args, stdin, tty=True):
        if len(args) < 2:
            raise CmdError("usage: chmod +x|-x|755|644 file...")
        mode, files = args[0], args[1:]
        if re.fullmatch(r"[0-7]{3}", mode):
            executable = bool(int(mode, 8) & 0o111)
        elif re.fullmatch(r"[uga]?\+x", mode):
            executable = True
        elif re.fullmatch(r"[uga]?-x", mode):
            executable = False
        else:
            raise CmdError(f"unsupported mode '{mode}' (use +x, -x, or an octal like 755 / 644)")
        for f in files:
            self.fs.chmod(self.p(f), executable)
        self._actions.append({"type": "fs_changed", "dirs": sorted({posixpath.dirname(self.p(f)) or "/" for f in files}), "files": [self.p(f) for f in files]})
        return ""

    def cmd_history(self, args, stdin, tty=True):
        return "".join(f"{i:>4}  {h}\n" for i, h in enumerate(self.history, 1))

    def cmd_clear(self, args, stdin, tty=True):
        self._clear = True
        return ""

    def cmd_exit(self, args, stdin, tty=True):
        if self.depth > 0:                                  # inside a script: leave the script, not the terminal
            try:
                self._exit = int(args[0]) if args else int(self.vars.get("?", "0") or 0)
            except ValueError:
                raise CmdError(f"numeric argument required: '{args[0]}'", 2)
            return ""
        self._actions.append({"type": "exit"})
        return ""

    def _open(self, kind, args):
        if not args:
            raise CmdError("missing path")
        target = self.p(args[0])
        info = self.fs.stat(target)
        self._actions.append({"type": "open", "app": kind, "path": target, "kind": info["type"]})
        return f"{DIM}opening {target}{RESET}\n"

    def cmd_open(self, args, stdin, tty=True):
        return self._open(None, args)

    def cmd_play(self, args, stdin, tty=True):
        return self._open("music", args)

    def cmd_code(self, args, stdin, tty=True):
        return self._open("code", args)

    cmd_edit = cmd_code

    def complete(self, line: str) -> list[str]:
        try:
            parts = shlex.split(line + "x")
        except ValueError:
            return []
        parts[-1] = parts[-1][:-1]
        word = parts[-1]
        if len(parts) == 1 and "/" not in word:
            names = set(self.commands) | set(self.vfs.names())
            return sorted(c for c in names if c.startswith(word))
        folder, _, prefix = word.rpartition("/")
        base = self.p((folder + "/") if folder or word.startswith("/") else ".")
        try:
            entries = self._fs_list(base)["content"]
        except FsError:
            return []
        keep = (e for e in entries if e["name"].startswith(prefix) and (prefix.startswith(".") or not e["hidden"]))
        lead = (folder + "/") if folder or word.startswith("/") else ""
        return sorted(lead + e["name"] + ("/" if e["type"] == "folder" else "") for e in keep)
