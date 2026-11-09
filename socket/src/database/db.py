import select
import threading
import time
from contextlib import contextmanager

from psycopg2 import InterfaceError, OperationalError
from psycopg2.pool import ThreadedConnectionPool


class DataBase(object):
    def __init__(self, host, db, user, password, *, port=5432, pool_size=10, wait_seconds=60, acquire_timeout=15):
        self._kwargs = dict(host=host, port=port, dbname=db, user=user, password=password, connect_timeout=5)

        self._slots = threading.BoundedSemaphore(pool_size)
        self._acquire_timeout = acquire_timeout
        deadline = time.time() + wait_seconds

        while True:
            try:
                self._pool = ThreadedConnectionPool(1, pool_size, **self._kwargs)
                break
            except OperationalError:
                if time.time() > deadline:
                    raise
                time.sleep(1)

    def dsn_kwargs(self) -> dict:
        return dict(self._kwargs)

    @staticmethod
    def _stale(conn) -> bool:
        if conn.closed:
            return True
        try:
            return bool(select.select([conn], [], [], 0)[0])
        except (OSError, ValueError):
            return True

    def _checkout(self):
        for _ in range(self._pool.maxconn + 1):
            conn = self._pool.getconn()
            if not self._stale(conn):
                return conn
            self._pool.putconn(conn, close=True)
        return self._pool.getconn()

    @contextmanager
    def cursor(self):
        if not self._slots.acquire(timeout=self._acquire_timeout):
            raise OperationalError("database busy: no connection became free in time")
        try:
            conn = self._checkout()
            try:
                with conn.cursor() as cur:
                    yield cur
                conn.commit()
            except BaseException as exc:
                try:
                    conn.rollback()
                except (OperationalError, InterfaceError):
                    pass
                raise exc
            finally:
                self._pool.putconn(conn, close=bool(conn.closed))
        finally:
            self._slots.release()

    def fetch_all(self, sql, params=()):
        with self.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def fetch_one(self, sql, params=()):
        with self.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def execute(self, sql, params=()) -> int:
        with self.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    def fetch_dao(self, table, instance, extension="", variables=()):
        columns = ", ".join(instance.SCHEMA)
        rows = self.fetch_all(f"SELECT {columns} FROM {table}{' ' + extension if extension else ''}", variables)
        return [instance(*row) for row in rows]

    def write_dao(self, table, obj, instance):
        values = obj.to_object()
        writable = [c for c in instance.SCHEMA if instance.SCHEMA[c] != "id"]
        placeholders = ", ".join(["%s"] * len(writable))
        row = self.fetch_one(
            f"INSERT INTO {table} ({', '.join(writable)}) VALUES ({placeholders}) RETURNING {', '.join(instance.SCHEMA)}",
            [values[c] for c in writable],
        )
        return [instance(*row)]

    def ping(self) -> bool:
        try:
            self.fetch_one("SELECT 1")
            return True
        except Exception:
            return False

    def close(self):
        self._pool.closeall()
