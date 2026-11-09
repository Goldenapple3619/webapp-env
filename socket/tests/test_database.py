"""
Gateway pieces that need a real Postgres (POSTGRES_* and DB_HOST set, as for the app); skipped otherwise.
    python3 -m unittest tests.test_database
"""
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.database.db import DataBase  # noqa: E402
from src.events import PgListener  # noqa: E402

ENV = {k: os.environ.get(k) for k in ("DB_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD")}
CONNECT = dict(host=ENV["DB_HOST"], dbname=ENV["POSTGRES_DB"], user=ENV["POSTGRES_USER"], password=ENV["POSTGRES_PASSWORD"])


def terminate_other_backends():
    admin = psycopg2.connect(**CONNECT)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute("SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")
        count = cur.fetchone()[0]
    admin.close()
    return count


@unittest.skipUnless(all(ENV.values()), "needs a database")
class DataBaseTests(unittest.TestCase):
    def make(self, size):
        db = DataBase(ENV["DB_HOST"], ENV["POSTGRES_DB"], ENV["POSTGRES_USER"], ENV["POSTGRES_PASSWORD"], pool_size=size)
        self.addCleanup(db.close)
        return db

    def test_callers_wait_for_a_connection_instead_of_failing(self):
        db, errors = self.make(3), []

        def work():
            try:
                db.fetch_one("SELECT pg_sleep(0.2)")
            except Exception as exc:  # the original pool raised PoolError('connection pool exhausted') here
                errors.append(repr(exc))

        threads = [threading.Thread(target=work) for _ in range(12)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])

    def test_a_restarted_database_does_not_cost_a_request(self):
        db = self.make(3)
        for _ in range(3):
            db.fetch_one("SELECT 1")
        self.assertGreaterEqual(terminate_other_backends(), 1)   # what a database restart does to pooled connections
        time.sleep(0.3)
        self.assertEqual([db.fetch_one("SELECT 1")[0] for _ in range(4)], [1, 1, 1, 1])

    def test_a_failed_statement_rolls_back_and_the_connection_is_reusable(self):
        db = self.make(1)
        with self.assertRaises(psycopg2.Error):
            db.fetch_one("SELECT 1/0")
        self.assertEqual(db.fetch_one("SELECT 2")[0], 2)

    def test_ping(self):
        self.assertTrue(self.make(1).ping())


@unittest.skipUnless(all(ENV.values()), "needs a database")
class ListenerTests(unittest.TestCase):
    def test_notifications_are_delivered_and_an_interruption_triggers_a_resync(self):
        got, resyncs = [], []
        listener = PgListener(CONNECT, {"fs_events": got.append}, on_resync=lambda: resyncs.append(time.time()))
        listener.start()
        self.addCleanup(listener.stop)
        self.assertTrue(listener.connected.wait(5))
        self.assertEqual(resyncs, [], "no resync on the very first connection")

        def notify(payload):
            conn = psycopg2.connect(**CONNECT)
            conn.autocommit = True
            conn.cursor().execute("SELECT pg_notify('fs_events', %s)", (json.dumps(payload),))
            conn.close()

        notify({"n": 1})
        end = time.time() + 5
        while not got and time.time() < end:
            time.sleep(0.05)
        self.assertEqual(got, [{"n": 1}])

        # The feed is cut. Whatever is NOTIFYed meanwhile is lost for good...
        listener.connected.clear()
        terminate_other_backends()
        end = time.time() + 15
        while not resyncs and time.time() < end:
            time.sleep(0.1)
        self.assertEqual(len(resyncs), 1, "after the feed came back the owner must be told to resync")

        # ... and the feed works again afterwards.
        self.assertTrue(listener.connected.wait(5))
        notify({"n": 2})
        end = time.time() + 5
        while len(got) < 2 and time.time() < end:
            time.sleep(0.05)
        self.assertEqual(got[-1], {"n": 2})


if __name__ == "__main__":
    unittest.main()
