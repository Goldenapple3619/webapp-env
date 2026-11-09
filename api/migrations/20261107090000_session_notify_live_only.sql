-- migrate:up
-- The revoke trigger also fired for every row removed by the hourly purge (sessions that ended more than a week ago):
-- thousands of pointless NOTIFYs, each making the gateway look for a socket that cannot exist. A deletion now only
-- announces a session that was still live (e.g. removed by deleting its user); a revocation always does.
CREATE OR REPLACE FUNCTION notify_session_revoked() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE' AND OLD.revoked_at IS NULL AND OLD.expires_at > now())
       OR (TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
        PERFORM pg_notify('session_events',
            json_build_object('event', 'revoked', 'sid', OLD.id, 'user', OLD.user_id)::text);
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$ LANGUAGE plpgsql;

-- migrate:down
CREATE OR REPLACE FUNCTION notify_session_revoked() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
        PERFORM pg_notify('session_events',
            json_build_object('event', 'revoked', 'sid', OLD.id, 'user', OLD.user_id)::text);
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$ LANGUAGE plpgsql;
