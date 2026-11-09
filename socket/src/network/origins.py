from urllib.parse import urlsplit

def origin_allowed(origin, host, allowed: list) -> bool:
    if not origin or not allowed:
        return True
    if origin in allowed:
        return True
    try:
        return bool(host) and urlsplit(origin).netloc == host
    except ValueError:
        return False
