"""
Desktop shortcuts: ``*.shc`` files holding a small XML document.

    <shortcut name="Music" icon="music" open="music" comment="Play something">
        <arg name="queue">/music/a.mp3</arg>
        <arg name="queue">/music/b.mp3</arg>
        <arg name="shuffle" type="boolean">true</arg>
        <window width="480" height="700" maximized="false"/>
    </shortcut>

* ``open``    id of the application to start (see the client's apps/registry.json). Optional when ``target`` is set.
* ``target``  a path in the user's files, opened with the application associated to its type
              (or with ``open`` when both are given: the path is then passed to it as ``path``).
* ``icon``    the name of a built-in icon, or an absolute path of an image in the user's files; empty = the app's own icon.
* ``<arg>``   free-form arguments handed to the application. A repeated name becomes a list.
* ``<window>`` optional start geometry.

The file is parsed HERE, never in the browser, so there is a single definition of "a valid shortcut": the Properties
window sends JSON, this module validates it and writes the XML; hand-edited files are validated by the same rules.
The parser refuses DTDs / entities outright (no entity-expansion tricks) and caps the size of the document.
"""
import re
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr

MAX_BYTES = 32 * 1024
MAX_ARGS = 32
MAX_VALUE = 2048
ARG_TYPES = ("string", "number", "boolean")

APP_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
ICON_NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ARG_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,31}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_FORBIDDEN_MARKUP = re.compile(r"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


class ShortcutError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _text(value, field: str, maximum: int, *, required=False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ShortcutError("invalid_" + field, f"{field} must be text")
    value = value.strip() if field != "value" else value
    if _CONTROL.search(value):
        raise ShortcutError("invalid_" + field, f"{field} contains control characters")
    if len(value) > maximum:
        raise ShortcutError("invalid_" + field, f"{field} is longer than {maximum} characters")
    if required and not value:
        raise ShortcutError("invalid_" + field, f"{field} is required")
    return value


def _path(value, field: str) -> str:
    value = _text(value, field, 1024)
    if value and (not value.startswith("/") or "\\" in value):
        raise ShortcutError("invalid_" + field, f"{field} must be an absolute path like /documents/a.txt")
    return value


def _flag(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _size(value, field: str):
    if value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ShortcutError("invalid_window", f"window {field} must be a number")
    if not 160 <= number <= 10000:
        raise ShortcutError("invalid_window", f"window {field} must be between 160 and 10000")
    return number


def normalize(data) -> dict:
    """Validates a shortcut given as a plain dict (what the client sends) and returns the canonical form."""
    if not isinstance(data, dict):
        raise ShortcutError("invalid_shortcut", "a shortcut is an object")
    name = _text(data.get("name"), "name", 80, required=True)
    open_ = _text(data.get("open"), "open", 32)
    if open_ and not APP_ID.match(open_):
        raise ShortcutError("invalid_open", "open must be an application id such as 'music'")
    icon = _text(data.get("icon"), "icon", 1024)
    if icon and not (ICON_NAME.match(icon) or (icon.startswith("/") and "\\" not in icon)):
        raise ShortcutError("invalid_icon", "icon must be a built-in icon name or an absolute image path")
    target = _path(data.get("target"), "target")
    if not open_ and not target:
        raise ShortcutError("invalid_shortcut", "a shortcut needs an application (open) or a target")
    comment = _text(data.get("comment"), "comment", 300)

    raw_args = data.get("args") or []
    if not isinstance(raw_args, list) or len(raw_args) > MAX_ARGS:
        raise ShortcutError("invalid_args", f"at most {MAX_ARGS} arguments")
    args = []
    for item in raw_args:
        if not isinstance(item, dict):
            raise ShortcutError("invalid_args", "an argument is {name, value, type}")
        arg_name = _text(item.get("name"), "arg", 32, required=True)
        if not ARG_NAME.match(arg_name):
            raise ShortcutError("invalid_args", f"'{arg_name}' is not a valid argument name")
        kind = item.get("type") or "string"
        if kind not in ARG_TYPES:
            raise ShortcutError("invalid_args", f"argument type must be one of {', '.join(ARG_TYPES)}")
        value = item.get("value")
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (int, float)):
            value = str(value)
        value = _text(value, "value", MAX_VALUE)
        if kind == "number":
            try:
                float(value)
            except ValueError:
                raise ShortcutError("invalid_args", f"'{arg_name}' is typed number but '{value}' is not one")
        if kind == "boolean" and value.lower() not in ("true", "false"):
            raise ShortcutError("invalid_args", f"'{arg_name}' is typed boolean: use true or false")
        args.append({"name": arg_name, "value": value, "type": kind})

    window = data.get("window") or {}
    if not isinstance(window, dict):
        raise ShortcutError("invalid_window", "window is an object")
    width, height = _size(window.get("width"), "width"), _size(window.get("height"), "height")
    out_window = {}
    if width:
        out_window["width"] = width
    if height:
        out_window["height"] = height
    if _flag(window.get("maximized")):
        out_window["maximized"] = True

    return {"name": name, "icon": icon, "open": open_, "target": target, "comment": comment,
            "args": args, "window": out_window}


def parse(text) -> tuple[dict, list]:
    """XML text -> (canonical shortcut, warnings). Raises ShortcutError."""
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ShortcutError("not_text", "a shortcut must be UTF-8 text")
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ShortcutError("too_large", "a shortcut file is limited to 32 KB")
    if "\x00" in text:
        raise ShortcutError("not_text", "binary data")
    if _FORBIDDEN_MARKUP.search(text):
        raise ShortcutError("forbidden_markup", "DOCTYPE and ENTITY declarations are not allowed")
    try:
        root = ElementTree.fromstring(text.strip())
    except ElementTree.ParseError as exc:
        raise ShortcutError("invalid_xml", str(exc))
    if root.tag != "shortcut":
        raise ShortcutError("invalid_xml", f"the root element must be <shortcut>, got <{root.tag}>")

    warnings = []
    known_attrs = {"name", "icon", "open", "target", "comment"}
    for attr in root.attrib:
        if attr not in known_attrs:
            warnings.append(f"attribute '{attr}' is not understood and will be dropped if the shortcut is saved from Properties")
    args, window = [], {}
    for child in root:
        if child.tag == "arg":
            args.append({"name": child.attrib.get("name", ""), "value": (child.text or "").strip(), "type": child.attrib.get("type", "string")})
        elif child.tag == "window":
            window = dict(child.attrib)
        else:
            warnings.append(f"element <{child.tag}> is not understood and will be dropped if the shortcut is saved from Properties")
    shortcut = normalize({**{k: root.attrib.get(k, "") for k in known_attrs}, "args": args, "window": window})
    return shortcut, warnings


def serialize(data) -> str:
    """Canonical dict -> XML text (validated first, so an invalid shortcut can never be written)."""
    s = normalize(data)
    attrs = [f"name={quoteattr(s['name'])}", f"icon={quoteattr(s['icon'])}"]
    if s["open"]:
        attrs.append(f"open={quoteattr(s['open'])}")
    if s["target"]:
        attrs.append(f"target={quoteattr(s['target'])}")
    if s["comment"]:
        attrs.append(f"comment={quoteattr(s['comment'])}")
    lines = [f"<shortcut {' '.join(attrs)}>"]
    for arg in s["args"]:
        type_attr = "" if arg["type"] == "string" else f" type={quoteattr(arg['type'])}"
        lines.append(f"    <arg name={quoteattr(arg['name'])}{type_attr}>{escape(arg['value'])}</arg>")
    if s["window"]:
        w = s["window"]
        parts = [f'{k}="{w[k]}"' for k in ("width", "height") if k in w]
        if w.get("maximized"):
            parts.append('maximized="true"')
        lines.append(f"    <window {' '.join(parts)}/>")
    lines.append("</shortcut>")
    return "\n".join(lines) + "\n"
