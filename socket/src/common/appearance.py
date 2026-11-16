"""
Validation of the per-user appearance (desktop background, taskbar, window frame, per-application themes) and of the
desktop icon layout. Both live in the user's appdata folder (never inside the files the user can browse), so this
module is the only thing that decides what may be stored there.

The browser turns these values into CSS custom properties through the CSSOM (setProperty), never by pasting text into a
stylesheet; and this module only lets through values that cannot be anything but a colour, a number, an enum member or a
path. Two independent layers, so a bug in one cannot become a style/script injection.
"""
import re

MAX_BYTES = 64 * 1024

HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
CSS_VAR = re.compile(r"^--[a-z][a-z0-9-]{0,40}$")
APP_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
PRESET_ID = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class AppearanceError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _color(value, where: str) -> str:
    if not isinstance(value, str) or not HEX_COLOR.match(value):
        raise AppearanceError("invalid_color", f"{where}: expected a hex colour like #fc82b8, got {value!r}")
    value = value.lower()
    if len(value) in (4, 5):  # #rgb(a) -> #rrggbb(aa)
        value = "#" + "".join(c * 2 for c in value[1:])
    return value


def _int(value, where: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise AppearanceError("invalid_number", f"{where}: expected a number")
    number = int(round(value))
    if not low <= number <= high:
        raise AppearanceError("invalid_number", f"{where}: must be between {low} and {high}")
    return number


def _enum(value, where: str, allowed) -> str:
    if value not in allowed:
        raise AppearanceError("invalid_choice", f"{where}: must be one of {', '.join(allowed)}")
    return value


def _bool(value, where: str) -> bool:
    if not isinstance(value, bool):
        raise AppearanceError("invalid_flag", f"{where}: expected true or false")
    return value


def _path(value, where: str) -> str:
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 1024 or _CONTROL.search(value) or "\\" in value:
        raise AppearanceError("invalid_path", f"{where}: expected an absolute path like /pictures/wall.png")
    return value


def _vars(raw, where: str, *, numbers: bool) -> dict:
    if not isinstance(raw, dict) or len(raw) > 48:
        raise AppearanceError("invalid_vars", f"{where}: expected an object with at most 48 entries")
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not CSS_VAR.match(key):
            raise AppearanceError("invalid_vars", f"{where}: '{key}' is not a valid custom property name")
        if isinstance(value, str):
            out[key] = _color(value, f"{where}.{key}")
        elif numbers and isinstance(value, (int, float)) and not isinstance(value, bool):
            if value != value or abs(value) > 100_000:
                raise AppearanceError("invalid_vars", f"{where}.{key}: number out of range")
            out[key] = int(value) if value == int(value) else round(float(value), 2)
        else:
            raise AppearanceError("invalid_vars", f"{where}.{key}: a colour" + (" or a number" if numbers else "") + " is expected")
    return out


def _section(raw, where: str) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise AppearanceError("invalid_section", f"{where}: expected an object")
    return raw


def normalize_appearance(data) -> dict:
    if not isinstance(data, dict):
        raise AppearanceError("invalid_appearance", "the appearance is an object")
    out = {"version": 1}

    if data.get("preset") is not None:
        if not isinstance(data["preset"], str) or not PRESET_ID.match(data["preset"]):
            raise AppearanceError("invalid_preset", "preset must be a short lowercase id")
        out["preset"] = data["preset"]

    if "colors" in data:
        out["colors"] = _vars(data["colors"], "colors", numbers=False)

    if "desktop" in data:
        d = _section(data["desktop"], "desktop")
        o = {}
        if "mode" in d:
            o["mode"] = _enum(d["mode"], "desktop.mode", ("gradient", "color", "image"))
        if "color" in d:
            o["color"] = _color(d["color"], "desktop.color")
        if "image" in d:
            o["image"] = _path(d["image"], "desktop.image") if d["image"] else ""
        if "fit" in d:
            o["fit"] = _enum(d["fit"], "desktop.fit", ("cover", "contain", "center", "tile", "stretch"))
        if "dim" in d:
            o["dim"] = _int(d["dim"], "desktop.dim", 0, 80)
        out["desktop"] = o

    if "taskbar" in data:
        t = _section(data["taskbar"], "taskbar")
        o = {}
        if "position" in t:
            o["position"] = _enum(t["position"], "taskbar.position", ("bottom", "top"))
        if "height" in t:
            o["height"] = _int(t["height"], "taskbar.height", 30, 72)
        for key in ("bg", "ink"):
            if key in t:
                o[key] = _color(t[key], f"taskbar.{key}")
        if "opacity" in t:
            o["opacity"] = _int(t["opacity"], "taskbar.opacity", 30, 100)
        for key in ("labels", "clock", "date", "tray"):
            if key in t:
                o[key] = _bool(t[key], f"taskbar.{key}")
        if "hour12" in t:
            o["hour12"] = _enum(t["hour12"], "taskbar.hour12", ("auto", "12", "24"))
        out["taskbar"] = o

    if "windows" in data:
        w = _section(data["windows"], "windows")
        o = {}
        for key in ("frame", "header", "headerInactive", "headerInk", "body"):
            if key in w:
                o[key] = _color(w[key], f"windows.{key}")
        if "radius" in w:
            o["radius"] = _int(w["radius"], "windows.radius", 0, 24)
        if "border" in w:
            o["border"] = _int(w["border"], "windows.border", 0, 10)
        if "shadow" in w:
            o["shadow"] = _enum(w["shadow"], "windows.shadow", ("none", "soft", "strong"))
        if "titleFont" in w:
            o["titleFont"] = _enum(w["titleFont"], "windows.titleFont", ("pixel", "ui"))
        if "buttons" in w:
            o["buttons"] = _enum(w["buttons"], "windows.buttons", ("square", "round"))
        if "animations" in w:
            o["animations"] = _bool(w["animations"], "windows.animations")
        out["windows"] = o

    if "apps" in data:
        apps = data["apps"]
        if not isinstance(apps, dict) or len(apps) > 24:
            raise AppearanceError("invalid_apps", "apps: expected an object with at most 24 applications")
        o = {}
        for app_id, conf in apps.items():
            if not isinstance(app_id, str) or not APP_ID.match(app_id):
                raise AppearanceError("invalid_apps", f"'{app_id}' is not an application id")
            conf = _section(conf, f"apps.{app_id}")
            entry = {}
            if "vars" in conf:
                entry["vars"] = _vars(conf["vars"], f"apps.{app_id}.vars", numbers=True)
            for key in ("frame", "header"):
                if key in conf:
                    entry[key] = _color(conf[key], f"apps.{app_id}.{key}")
            if entry:
                o[app_id] = entry
        out["apps"] = o
    return out


def normalize_layout(data) -> dict:
    """{"seeded": bool, "items": {"Music.shc": {"c": 0, "r": 1}}} - positions are grid cells, keyed by file name."""
    if not isinstance(data, dict):
        raise AppearanceError("invalid_layout", "the layout is an object")
    items_in = data.get("items", {})
    if not isinstance(items_in, dict) or len(items_in) > 3000:
        raise AppearanceError("invalid_layout", "items: expected an object with at most 3000 entries")
    items = {}
    for name, cell in items_in.items():
        if not isinstance(name, str) or not 0 < len(name) <= 255 or "/" in name or "\\" in name or _CONTROL.search(name):
            raise AppearanceError("invalid_layout", f"'{name}' is not a file name")
        if not isinstance(cell, dict):
            raise AppearanceError("invalid_layout", f"{name}: expected {{c, r}}")
        items[name] = {"c": _int(cell.get("c"), f"{name}.c", 0, 999), "r": _int(cell.get("r"), f"{name}.r", 0, 999)}
    return {"version": 1, "seeded": bool(data.get("seeded")), "items": items}
