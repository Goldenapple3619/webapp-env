import json
import select
import threading
import time
from traceback import format_exc

import psycopg2

CHANNELS = ("fs_events", "session_events", "desktop_events")


class PgListener(threading.Thread):
    def __init__(self, dsn_kwargs: dict, handlers: dict, on_resync=None):
        super().__init__(daemon=True, name="pg-listener")
        self._dsn = dsn_kwargs
        self._handlers = handlers
        self._on_resync = on_resync
        self._halt = threading.Event()
        self.connected = threading.Event()

    def stop(self):
        self._halt.set()

    def run(self):
        backoff = 1
        interrupted = False
        while not self._halt.is_set():
            conn = None
            try:
                conn = psycopg2.connect(**self._dsn)
                conn.autocommit = True
                with conn.cursor() as cur:
                    for channel in CHANNELS:
                        cur.execute(f"LISTEN {channel}")
                backoff = 1
                self.connected.set()
                if interrupted and self._on_resync:
                    try:
                        self._on_resync()
                    except Exception:
                        print(f"[events] resync error: {format_exc()}", flush=True)
                interrupted = False
                while not self._halt.is_set():
                    if not select.select([conn], [], [], 5)[0]:
                        continue
                    conn.poll()
                    while conn.notifies:
                        note = conn.notifies.pop(0)
                        handler = self._handlers.get(note.channel)
                        if handler:
                            try:
                                handler(json.loads(note.payload))
                            except Exception:
                                print(f"[events] handler error on {note.channel}: {format_exc()}", flush=True)
            except Exception as exc:
                interrupted = True
                self.connected.clear()
                print(f"[events] listener lost ({exc}); retrying in {backoff}s", flush=True)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass
