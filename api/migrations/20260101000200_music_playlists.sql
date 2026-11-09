-- migrate:up
-- Playlists move from ad-hoc ".lst" files in appdata to real tables (this is the schema that
-- was sketched in comments in the old schema.sql; "order" is a reserved word, hence "position").

CREATE TABLE IF NOT EXISTS playlists
(
    id            SERIAL      NOT NULL PRIMARY KEY,
    user_id       integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    creation_date timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS playlist_songs
(
    id          SERIAL      NOT NULL PRIMARY KEY,
    playlist_id integer     NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    position    integer     NOT NULL,
    name        text        NOT NULL,
    endpoint    text        NOT NULL,  -- path relative to the user's root, e.g. /music/a.mp3
    cover       text,                  -- optional path to an image, relative to the user's root
    added_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playlist_songs_order_idx ON playlist_songs (playlist_id, position);

-- migrate:down
DROP TABLE IF EXISTS playlist_songs;
DROP TABLE IF EXISTS playlists;
