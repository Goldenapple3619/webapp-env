CREATE TABLE IF NOT EXISTS users
(
    id SERIAL NOT NULL PRIMARY KEY,
    creation_date timestamp NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    token TEXT
);

-- CREATE TABLE IF NOT EXISTS playlists
-- (
--     id SERIAL NOT NULL PRIMARY KEY,
--     creation_date timestamp NOT NULL,
--     user_id INT NOT NULL,

--     CONSTRAINT fk_user
--         FOREIGN KEY(user_id)
--             REFERENCES users(id)
--             ON DELETE CASCADE
-- );

-- CREATE TABLE IF NOT EXISTS playlist_songs
-- (
--     id SERIAL NOT NULL PRIMARY KEY,
--     name TEXT NOT NULL,
--     cover TEXT,
--     endpoint TEXT NOT NULL,
--     order INT NOT NULL,
--     playlist_id INT NOT NULL,

--     CONSTRAINT fk_playlist
--         FOREIGN KEY(playlist_id)
--             REFERENCES playlists(id)
--             ON DELETE CASCADE
-- );

CREATE TABLE IF NOT EXISTS wsockets
(
    host TEXT NOT NULL PRIMARY KEY
);


INSERT INTO wsockets (host)
SELECT '127.0.0.1:2117'
WHERE
NOT EXISTS (
SELECT host FROM wsockets WHERE host = '127.0.0.1:2117'
);
