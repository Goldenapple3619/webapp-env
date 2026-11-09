-- migrate:up
-- Baseline of the original schema (config/schema.sql). Everything is IF NOT EXISTS so
-- that databases created by the previous version adopt the migration system untouched.

CREATE TABLE IF NOT EXISTS users
(
    id            SERIAL    NOT NULL PRIMARY KEY,
    creation_date timestamp NOT NULL DEFAULT now(),
    username      TEXT      NOT NULL UNIQUE,
    password      TEXT      NOT NULL,
    token         TEXT
);

CREATE TABLE IF NOT EXISTS wsockets
(
    host TEXT NOT NULL PRIMARY KEY
);

-- migrate:down
-- The baseline is intentionally irreversible: it only describes what already existed.
SELECT 1;
