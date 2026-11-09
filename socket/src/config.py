from os import environ
from urllib.parse import urlsplit

_problems: list[str] = []


def _int(name: str, default: int, minimum: int = -(2 ** 31), maximum: int = 2 ** 31) -> int:
    raw = environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        value = None
    if value is None or not minimum <= value <= maximum:
        _problems.append(f"{name} must be an integer in [{minimum}, {maximum}], got '{raw}'")
        return default
    return value


def _list(name: str) -> list[str]:
    return [item.strip() for item in environ.get(name, "").split(",") if item.strip()]


def _origin(name: str, value: str):
    """'https://app.example.com/' -> 'https://app.example.com': exactly what browsers put in Origin."""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        _problems.append(f"{name} contains '{value}', which is not an origin like https://app.example.com")
        return None
    return f"{parts.scheme}://{parts.netloc}"


def _origins() -> list[str]:
    found = []
    if environ.get("PUBLIC_URL"):
        found.append(_origin("PUBLIC_URL", environ["PUBLIC_URL"]))
    for name in ("CORS_ORIGINS", "WS_ALLOWED_ORIGINS"):
        found += [_origin(name, item) for item in _list(name)]
    return list(dict.fromkeys(item for item in found if item))


class Config:
    host = "0.0.0.0"
    port = _int("WS_INTERNAL_PORT", 8001, 1, 65535)

    db_host = environ.get("DB_HOST", "db")
    db_port = _int("DB_PORT", 5432, 1, 65535)
    db_name = environ.get("POSTGRES_DB", "")
    db_user = environ.get("POSTGRES_USER", "")
    db_password = environ.get("POSTGRES_PASSWORD", "")
    db_pool_size = _int("DB_POOL_SIZE", 10, 1, 200)

    jwt_secret = environ.get("JWT_SECRET", "")
    jwt_issuer = "webapp-env"

    token_grace_seconds = 30

    hard_expiry_seconds = 120

    system_root = environ.get("SYSTEM_ROOT", "/mnt/system")

    allowed_origins = _origins()

    max_message_bytes = _int("WS_MAX_MESSAGE_KB", 1024, 1, 1024 * 64) * 1024
    rate_burst = _int("WS_RATE_BURST", 80, 1, 100000)
    rate_per_second = _int("WS_RATE_PER_SECOND", 40, 1, 100000)
    rate_strikes = _int("WS_RATE_STRIKES", 200, 1, 1000000)
    max_connections_per_user = _int("WS_MAX_CONNECTIONS_PER_USER", 20, 1, 1000)
    auth_timeout_seconds = _int("WS_AUTH_TIMEOUT_SECONDS", 10, 1, 600)
    max_unauthenticated = _int("WS_MAX_UNAUTHENTICATED", 200, 1, 100000)
    pre_auth_max_bytes = _int("WS_PRE_AUTH_MAX_BYTES", 16 * 1024, 256, 1024 * 1024)
    outbox_size = _int("WS_OUTBOX_SIZE", 256, 8, 100000)

    @classmethod
    def validate(cls) -> None:
        problems = list(_problems)
        if len(cls.jwt_secret) < 32:
            problems.append("JWT_SECRET must be set (same value as the API, >= 32 characters)")
        for key, variable in (("db_name", "POSTGRES_DB"), ("db_user", "POSTGRES_USER"), ("db_password", "POSTGRES_PASSWORD")):
            if not getattr(cls, key):
                problems.append(f"{variable} is missing")
        if cls.max_connections_per_user < 1:
            problems.append("WS_MAX_CONNECTIONS_PER_USER must be at least 1")
        if problems:
            raise RuntimeError("invalid configuration:\n  - " + "\n  - ".join(problems))
