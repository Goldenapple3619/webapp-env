-- migrate:up
-- Audit trail of the REAL programs (gcc, python, user binaries...) run through the sandbox runner: who ran what, how it
-- ended. Builtin shell commands are not logged. Rows are purged by the gateway after EXEC_AUDIT_DAYS (default 30).
CREATE TABLE IF NOT EXISTS exec_log
(
    id          bigserial   NOT NULL PRIMARY KEY,
    user_id     integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    tool        text        NOT NULL,
    argv        text        NOT NULL DEFAULT '',   -- truncated to 500 characters by the gateway
    status      integer,
    outcome     text        NOT NULL,              -- ok | exit | timeout | signal | cancelled | busy | unavailable | denied ...
    duration_ms integer
);

CREATE INDEX IF NOT EXISTS exec_log_user_idx    ON exec_log (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS exec_log_started_idx ON exec_log (started_at);

-- migrate:down
DROP TABLE IF EXISTS exec_log;
