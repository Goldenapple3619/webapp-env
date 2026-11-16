"""
Client of the sandbox runner (see /runner): the only way this gateway ever executes anything that is not Python in
this process. The runner is a separate container that has the toolchains, no secrets, no network and per-job isolation;
here we only speak its tiny HTTP+JSON protocol:

    GET  /v1/tools   -> {"sandbox": "bwrap", "tools": [{"name", "description", "version", "limits": {...}}]}
    POST /v1/run     -> {"status", "stdout", "stderr", "timed_out", "cancelled", "truncated", "signal", "duration_ms"}
    POST /v1/cancel  -> {"cancelled": bool}

Stdlib only. A failing runner must never take the gateway down with it: calls have hard timeouts, and after a few
consecutive connection failures the client answers "unavailable" immediately for a short while (circuit breaker) instead
of letting every terminal pile up threads waiting on a dead host.
"""
import http.client
import json
import threading
import time
from urllib.parse import urlsplit

PROTOCOL = 1
MAX_REPLY = 8 * 1024 * 1024


class RunnerError(Exception):
    """code: unavailable | busy | denied | bad_request | bad_reply"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class DisabledRunner:
    enabled = False

    def tools(self, force=False) -> dict:
        return {"sandbox": None, "tools": [], "error": "no sandbox runner is configured on this server"}

    def run(self, request: dict) -> dict:
        raise RunnerError("unavailable", "no sandbox runner is configured on this server")

    def cancel(self, job: str) -> bool:
        return False


class RunnerClient:
    enabled = True

    def __init__(self, url: str, token: str, *, connect_timeout=2.0, call_timeout=75.0, catalog_ttl=30.0,
                 failure_threshold=3, cooldown=10.0, clock=time.monotonic):
        parts = urlsplit(url)
        self._https = parts.scheme == "https"
        self._host, self._port = parts.hostname, parts.port or (443 if self._https else 80)
        self._prefix = parts.path.rstrip("/")
        self._token = token
        self._connect_timeout, self._call_timeout = connect_timeout, call_timeout
        self._ttl, self._threshold, self._cooldown, self._clock = catalog_ttl, failure_threshold, cooldown, clock
        self._lock = threading.Lock()
        self._failures, self._open_until = 0, 0.0
        self._catalog, self._catalog_at = None, 0.0

    def _request(self, method: str, path: str, body=None, timeout=None):
        with self._lock:
            if self._clock() < self._open_until:
                raise RunnerError("unavailable", "the sandbox runner is not reachable right now")
        conn_class = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        conn = conn_class(self._host, self._port, timeout=self._connect_timeout)
        try:
            payload = json.dumps(body).encode() if body is not None else None
            conn.connect()
            conn.sock.settimeout(timeout or self._call_timeout)
            conn.request(method, self._prefix + path, body=payload, headers={
                "Authorization": "Bearer " + self._token, "Content-Type": "application/json", "Connection": "close"})
            response = conn.getresponse()
            raw = response.read(MAX_REPLY + 1)
        except (OSError, http.client.HTTPException) as exc:
            self._note(failed=True)
            raise RunnerError("unavailable", f"the sandbox runner did not answer ({type(exc).__name__})")
        finally:
            conn.close()
        self._note(failed=False)
        if len(raw) > MAX_REPLY:
            raise RunnerError("bad_reply", "the runner's answer was too large")
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            raise RunnerError("bad_reply", "the runner sent something that is not JSON")
        if response.status == 429 or response.status == 503:
            raise RunnerError("busy", data.get("message", "the sandbox is busy, try again in a moment"))
        if response.status in (401, 403):
            raise RunnerError("denied", "the sandbox runner refused this gateway (check RUNNER_TOKEN)")
        if response.status >= 400:
            raise RunnerError("bad_request", str(data.get("message", f"runner error {response.status}")))
        if not isinstance(data, dict):
            raise RunnerError("bad_reply", "unexpected answer")
        return data

    def _note(self, failed: bool) -> None:
        with self._lock:
            if not failed:
                self._failures = 0
                return
            self._failures += 1
            if self._failures >= self._threshold:
                self._open_until = self._clock() + self._cooldown
                self._failures = 0

    def tools(self, force=False) -> dict:
        """The catalog (cached): what can be run, with which limits. Never raises: {"tools": [], "error": ...} when down."""
        with self._lock:
            fresh = self._catalog is not None and self._clock() - self._catalog_at < (self._ttl if not self._catalog.get("error") else 5.0)
            if fresh and not force:
                return self._catalog
        try:
            data = self._request("GET", "/v1/tools", timeout=self._connect_timeout + 3)
            catalog = {"sandbox": data.get("sandbox"), "tools": [t for t in data.get("tools", []) if isinstance(t, dict) and isinstance(t.get("name"), str)]}
        except RunnerError as exc:
            catalog = {"sandbox": None, "tools": [], "error": str(exc)}
        with self._lock:
            self._catalog, self._catalog_at = catalog, self._clock()
        return catalog

    def run(self, request: dict) -> dict:
        return self._request("POST", "/v1/run", {"v": PROTOCOL, **request})

    def cancel(self, job: str) -> bool:
        try:
            return bool(self._request("POST", "/v1/cancel", {"job": job}, timeout=5).get("cancelled"))
        except RunnerError:
            return False


_shared = None
_shared_lock = threading.Lock()


def shared_runner():
    """One client per process, built from the environment (RUNNER_URL / RUNNER_TOKEN)."""
    global _shared
    with _shared_lock:
        if _shared is None:
            from ..config import Config
            _shared = RunnerClient(Config.runner_url, Config.runner_token) if Config.runner_url else DisabledRunner()
        return _shared
