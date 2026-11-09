-- migrate:up
-- Several websocket gateways can be registered; clients try them by ascending priority.
-- A host may be a bare "host:port", a full ws:// / wss:// URL, or a path such as "/ws"
-- (meaning "this same origin", which is what the bundled nginx exposes).

ALTER TABLE wsockets ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;
ALTER TABLE wsockets ADD COLUMN IF NOT EXISTS enabled  boolean NOT NULL DEFAULT true;
ALTER TABLE wsockets ADD COLUMN IF NOT EXISTS label    text;

INSERT INTO wsockets (host, priority, label)
VALUES ('/ws', 0, 'default (same origin, through nginx)')
ON CONFLICT (host) DO NOTHING;

-- migrate:down
DELETE FROM wsockets WHERE host = '/ws';
ALTER TABLE wsockets DROP COLUMN IF EXISTS label;
ALTER TABLE wsockets DROP COLUMN IF EXISTS enabled;
ALTER TABLE wsockets DROP COLUMN IF EXISTS priority;
