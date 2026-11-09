-- migrate:up

-- 1. Users ---------------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN creation_date TYPE timestamptz USING creation_date AT TIME ZONE 'UTC';
ALTER TABLE users ALTER COLUMN creation_date SET DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Case-insensitive uniqueness ("Alice" vs "alice"). Skipped (with a notice) when an old
-- database already contains such a pair, so the migration can never fail on legacy data.
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (lower(username));
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'users_username_lower_key not created: usernames differing only by case exist';
END
$$;

-- The legacy "token" column held a never-expiring JWT per user. It is replaced by the
-- sessions table below, so every old token stops working (users simply log in again).
ALTER TABLE users DROP COLUMN IF EXISTS token;

-- 2. Sessions ------------------------------------------------------------------------------
-- One row per login (device / browser). The refresh token itself is never stored, only its
-- SHA-256. On every refresh the token is rotated; the previous hash is kept for a few seconds
-- so that two tabs refreshing at once are not mistaken for token theft.
CREATE TABLE IF NOT EXISTS sessions
(
    id                uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    refresh_hash      text        NOT NULL UNIQUE,
    prev_refresh_hash text,
    rotated_at        timestamptz,
    user_agent        text,
    ip                text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_used_at      timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    revoked_at        timestamptz,
    revoked_reason    text
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_prev_hash_idx   ON sessions (prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_expires_idx     ON sessions (expires_at);

-- Tell the websocket gateway immediately when a session is revoked (logout, "sign out other
-- devices", theft detection, password change...) so live connections are dropped at once.
CREATE OR REPLACE FUNCTION notify_session_revoked() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
        PERFORM pg_notify('session_events',
            json_build_object('event', 'revoked', 'sid', OLD.id, 'user', OLD.user_id)::text);
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_notify_revoked ON sessions;
CREATE TRIGGER sessions_notify_revoked
    AFTER UPDATE OF revoked_at OR DELETE ON sessions
    FOR EACH ROW EXECUTE FUNCTION notify_session_revoked();

-- migrate:down
DROP TRIGGER IF EXISTS sessions_notify_revoked ON sessions;
DROP FUNCTION IF EXISTS notify_session_revoked();
DROP TABLE IF EXISTS sessions;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token TEXT;
DROP INDEX IF EXISTS users_username_lower_key;
ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE users DROP COLUMN IF EXISTS updated_at;
