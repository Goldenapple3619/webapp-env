import fnmatch
import posixpath
import shlex
import time
from dataclasses import dataclass, field

from .userfs import FsError, UserFS, normalize

MAX_OUTPUT = 256 * 1024
BLUE, GREEN, DIM, RED, RESET = "\x1b[1;34m", "\x1b[32m", "\x1b[2m", "\x1b[31m", "\x1b[0m"
AUDIO = {"mp3", "ogg", "wav", "flac", "m4a", "aac", "opus"}

HELP = """Built-in commands (virtual shell - nothing here can leave your own files):
  ls [-l] [-a] [path]    cd [path]       pwd          tree [-L n] [path]
  cat file...            head/tail [-n N] [file]       wc [-l|-w|-c] [file]
  mkdir [-p] dir...      touch file...   rm [-r] [-f] path...      rmdir dir...
  cp [-r] src dst        mv src dst      stat path    du [-h] [path]
  find [path] -name PAT  grep [-i] [-n] [-r] PAT [file...]         sort [-r] / uniq
  echo text              whoami  hostname  date  uname  env  history  clear
  open <path>            open a file/folder with the matching app
  play <file>            play a music file      code <file>   edit a file
Pipes (cmd | cmd), redirects (> >>), ';' and '&&' work. Tab completes, Up/Down = history."""

@dataclass
class Result:
    output: str = ""
    status: int = 0
    clear: bool = False
    actions: list = field(default_factory=list)

OPERATOR_CHARS = "|&;<>"

class Op(str):
    """An UNQUOTED shell operator. A quoted ">" or "|" is ordinary text, so it is a plain str, not an Op."""

def tokenize(line: str) -> list:
    tokens, buf, started, i, n = [], [], False, 0, len(line)

    def flush():
        nonlocal buf, started
        if started:
            tokens.append("".join(buf))
        buf, started = [], False

    while i < n:
        ch = line[i]
        if ch.isspace():
            flush()
            i += 1
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
            buf.append(line[i + 1:j])
            started, i = True, j + 1
        elif ch == '"':
            i, closed = i + 1, False
            while i < n:
                c = line[i]
                if c == '"':
                    closed, i = True, i + 1
                    break
                if c == "\\" and i + 1 < n and line[i + 1] in '"\\':
                    buf.append(line[i + 1])
                    i += 2
                    continue
                buf.append(c)
                i += 1
            if not closed:
                raise ValueError("No closing quotation")
            started = True
        elif ch == "\\":
            if i + 1 >= n:
                raise ValueError("No escaped character")
            buf.append(line[i + 1])
            started, i = True, i + 2
        else:
            buf.append(ch)
            started, i = True, i + 1
    flush()
    return tokens


class CmdError(Exception):
    def __init__(self, message, status=1, output=""):
        super().__init__(message)
        self.status = status
        self.output = output

class Shell:
    def __init__(self, fs: UserFS, username: str):
        self.fs = fs
        self.username = username
        self.cwd = "/"
        self.history: list[str] = []
        self._actions: list = []
        self._clear = False
        self.commands = {
            n[4:]: getattr(self, n) for n in dir(self) if n.startswith("cmd_")
        }

    def p(self, arg: str) -> str:
        arg = self.expand(arg)
        if arg == "~" or arg.startswith("~/"):
            arg = "/" + arg[1:].lstrip("/")
        return normalize(arg if arg.startswith("/") else posixpath.join(self.cwd, arg))

    def expand(self, text: str) -> str:
        env = {"HOME": "/", "USER": self.username, "PWD": self.cwd}
        for k, v in env.items():
            text = text.replace("${" + k + "}", v).replace("$" + k, v)
        return text

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
        return self.fs.read_text(self.p(path), limit=4 * 1024 * 1024)["content"]

    def inputs(self, files, stdin):
        return "".join(self.read(f) for f in files) if files else (stdin or "")

    def run(self, line: str) -> Result:
        self._actions, self._clear = [], False
        line = line.strip()
        if not line:
            return Result()
        self.history = (self.history + [line])[-200:]
        out, status = [], 0
        try:
            tokens = tokenize(line)
        except ValueError as exc:
            return Result(f"{RED}syntax error: {exc}{RESET}\n", 2)

        groups, cur, op = [], [], ";"
        for tok in tokens:
            if isinstance(tok, Op) and tok in (";", "&&"):
                groups.append((op, cur))
                cur, op = [], tok
            else:
                cur.append(tok)
        groups.append((op, cur))

        for op, toks in groups:
            if op == "&&" and status != 0:
                continue
            if not toks:
                continue
            text, status = self.pipeline(toks)
            if text:
                out.append(text)
        output = "".join(out)
        if len(output) > MAX_OUTPUT:
            output = output[:MAX_OUTPUT] + f"\n{DIM}[output truncated]{RESET}\n"
        return Result(output, status, self._clear, self._actions)

    def pipeline(self, tokens):
        stages, cur = [], []
        for tok in tokens:
            if isinstance(tok, Op) and tok == "|":
                stages.append(cur)
                cur = []
            else:
                cur.append(tok)
        stages.append(cur)

        data, status = None, 0
        for i, stage in enumerate(stages):
            last = i == len(stages) - 1
            redirect = None
            if last:
                idx = next((k for k, tok in enumerate(stage) if isinstance(tok, Op) and tok in (">>", ">")), None)
                if idx is not None:
                    if idx + 1 >= len(stage):
                        return f"{RED}syntax error: missing redirect target{RESET}\n", 2
                    redirect = (str(stage[idx]), stage[idx + 1])
                    stage = stage[:idx] + stage[idx + 2:]
            if not stage:
                return f"{RED}syntax error: empty command{RESET}\n", 2
            name, args = stage[0], [self.expand(a) for a in stage[1:]]
            fn = self.commands.get(name)
            if not fn:
                return f"{name}: command not found\n", 127
            try:
                data, status = fn(args, data, tty=(last and not redirect)), 0
            except CmdError as exc:
                return f"{exc.output}{name}: {exc}\n", exc.status
            except FsError as exc:
                return f"{name}: {exc.code.replace('_', ' ')}{(': ' + str(exc)) if str(exc) != exc.code else ''}\n", 1
            except UnicodeError:
                return f"{name}: binary data\n", 1
            if redirect:
                sym, target = redirect
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

    def cmd_pwd(self, args, stdin, tty=True):
        return self.cwd + "\n"

    def cmd_cd(self, args, stdin, tty=True):
        target = self.p(args[0]) if args else "/"
        if self.fs.stat(target)["type"] != "folder":
            raise CmdError(f"{args[0]}: not a directory")
        self.cwd = target
        return ""

    def cmd_ls(self, args, stdin, tty=True):
        on, _, paths = self.flags(args, "lah1")
        out = []
        for path in paths or ["."]:
            info = self.fs.stat(self.p(path))
            entries = self.fs.listdir(self.p(path))["content"] if info["type"] == "folder" else [info]
            if "a" not in on:
                entries = [e for e in entries if not e["hidden"]] if info["type"] == "folder" else entries
            if len(paths) > 1:
                out.append(f"{path}:")
            for e in entries:
                label = e["name"] + ("/" if e["type"] == "folder" else "")
                if tty and e["type"] == "folder":
                    label = f"{BLUE}{label}{RESET}"
                elif tty and e["ext"] in AUDIO:
                    label = f"{GREEN}{label}{RESET}"
                if "l" in on:
                    when = time.strftime("%b %d %H:%M", time.localtime(e["modification_date"]))
                    size = self.human(e["size"]) if "h" in on else str(e["size"])
                    out.append(f"{'d' if e['type'] == 'folder' else '-'} {size:>8} {when} {label}")
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
            entries = [e for e in self.fs.listdir(path)["content"] if not e["hidden"]]
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
            self.fs.stat(path)
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
                if self.fs.stat(target)["type"] == "folder" and "r" not in on:
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
            e = self.fs.stat(self.p(path))
            out.append(f"  File: {e['path']}\n  Type: {e['type']}\n  Size: {e['size']}\n"
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
        return f"HOME=/\nUSER={self.username}\nPWD={self.cwd}\nSHELL=/virtual/sh\n"

    def cmd_history(self, args, stdin, tty=True):
        return "".join(f"{i:>4}  {h}\n" for i, h in enumerate(self.history, 1))

    def cmd_clear(self, args, stdin, tty=True):
        self._clear = True
        return ""

    def cmd_exit(self, args, stdin, tty=True):
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
        if len(parts) == 1:
            return sorted(c for c in self.commands if c.startswith(word))
        folder, _, prefix = word.rpartition("/")
        base = self.p((folder + "/") if folder or word.startswith("/") else ".")
        try:
            entries = self.fs.listdir(base)["content"]
        except FsError:
            return []
        keep = (e for e in entries if e["name"].startswith(prefix) and (prefix.startswith(".") or not e["hidden"]))
        lead = (folder + "/") if folder or word.startswith("/") else ""
        return sorted(lead + e["name"] + ("/" if e["type"] == "folder" else "") for e in keep)
