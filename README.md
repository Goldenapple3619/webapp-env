# webapp-env

A web-based desktop environment: log in from a browser (or the native suite), get a virtual desktop with
windows, and run apps (Explorer, Music, Code, Terminal) against **your own files stored on the server**.

```
 browser tab ─┐                         ┌──────────────── docker compose ───────────────────────────────────┐
 desktop suite┼─►  web (nginx :8080) ───┤  /           static client (minified, content-hashed, gzip)        │
 (Electron)  ─┘                         │  /api/*  ──► api     REST: accounts, sessions, file up/download    │
                                        │  /ws     ──► socket  websocket "apps gateway" (Python)          │
                                        │                api + socket ──► db (Postgres 15)  +  ./system     │
                                        └────────────────────────────────────────────────────────────────────┘
```

| folder | what |
|---|---|
| `client/` | static front-end (vanilla JS + your `l*.js` libraries), built and served by nginx |
| `api/` | Node/Express REST API: register, login, **sessions**, file upload/download/zip. Owns the schema: `api/migrations` are applied at start-up |
| `socket/` | Python websocket gateway; loads the server side of each app from `apps.xml` |
| `suite/` | Electron desktop suite: the apps as native windows on your real desktop |

## Quick start

```bash
./scripts/init-env.sh            # creates .env with random secrets (or: cp .env.example .env and edit)
docker compose up -d --build
# open http://localhost  (the first visit offers "Create an account")
```

Set `ALLOW_REGISTRATION=false` in `.env` once your accounts exist. Behind HTTPS (recommended) put any TLS
proxy in front of `web`; cookies become `Secure` automatically (nginx forwards `X-Forwarded-Proto`).

## Upgrading from the previous version

Do these in order. **Back up first**: `./system` (users' files) and the database
(`docker compose exec db pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`).

1. **Keep your `.env`**, and add `JWT_SECRET=$(openssl rand -hex 48)`. Keep `SALT` as it is: it is the password
   pepper, and changing it locks everybody out. `API_PORT` / `SOCKET_PORT` are no longer used (only `web` is published).
2. `docker compose up -d --build`. On the way:
   * the `api` applies `api/migrations` to your existing database before it listens: the old tables are adopted,
     `users.token` (the never-expiring tokens) is dropped, `sessions`, `playlists`, `playlist_songs` are created.
     Nothing is lost. (There is no separate `migrate` container any more; a database already migrated by it is
     recognised: same `schema_migrations` table, same checksums.) The `socket` starts once the api is healthy.
   * `init-system` re-owns `./system` for the unprivileged container user (uid 10001). Your files stay where they are.
   * The database image is still `postgres:15`, so the existing volume keeps working.
3. **Everyone has to log in again** (the old static tokens are gone). Passwords keep working: legacy hashes are
   verified and silently upgraded to the stronger v2 format on the next login.
4. Old playlists (`appdata/musicApp/playlists/*.lst`) can be imported once:
   `docker compose run --rm socket python scripts/import_legacy_playlists.py` (`--dry-run` first if you like).
5. The login page no longer needs the "host" field: the client is served by the same nginx as the API.
   (It is kept, collapsed under "Server", for pointing a client at another server; see `CORS_ORIGINS`.)

Removed on purpose: `GET /settoken` (it put the token in a URL and was an open redirect), `method-override`,
Apache config, the `config/schema.sql` bootstrap (replaced by migrations).

## Configuration (`.env`)

| variable | default | |
|---|---|---|
| `WEBSERVER_PORT` | `80` | the only published port |
| `SYSTEM_DIR` | `./system` | host folder with the users' files |
| `POSTGRES_DB` / `_USER` / `_PASSWORD` | | required |
| `SALT` | | required; password pepper (keep your old value) |
| `JWT_SECRET` | | **required**, ≥ 32 chars, shared by api and socket |
| `ACCESS_TOKEN_TTL` | `900` | seconds an access token lives |
| `SESSION_TTL_DAYS` / `SESSION_MAX_DAYS` | `30` / `90` | sliding lifetime of a login / absolute maximum |
| `ALLOW_REGISTRATION` | `true` | |
| `COOKIE_SECURE` | `auto` | `auto` follows the request scheme |
| `COOKIE_SAMESITE` | `auto` | `auto` = strict, but `SameSite=None; Secure` for pages listed in `CORS_ORIGINS` (https only). `strict`/`lax`/`none` force one value: an explicit `strict` disables cross-site logins |
| `PUBLIC_URL` | empty | public address of this installation (an origin); implicitly allowed |
| `CORS_ORIGINS` | empty | origins of OTHER sites that may use the API **and** open a websocket (empty = same origin only for the API) |
| `TRUST_PROXY` | `1` | reverse proxies in front of the api (nginx = 1; add one behind Traefik/Cloudflare) |
| `MAX_UPLOAD_MB` | `2048` | |
| `RATE_LIMITS` | `on` | `off` disables login/registration limits (dev/test); tune with `RATE_LIMIT_LOGIN_PER_MINUTE` / `RATE_LIMIT_REGISTER_PER_HOUR` (10 / 10, per IP) |
| `WS_ALLOWED_ORIGINS` | empty | gateway-only extra origins. With none of `PUBLIC_URL`/`CORS_ORIGINS`/this set, any origin may open a socket (auth is a token sent as a message, never a cookie) |
| `CSP_REMOTE_SRC` | empty | other servers this client talks to (e.g. `https://api.example.com`): added to `connect-src`, `img-src` and `media-src` |
| `CSP_CONNECT_SRC` | `'self' ws: wss:` | CSP `connect-src` of the pages (advanced) |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | `1200` | per IP, whole API except file reads |
| `MAX_CONCURRENT_ZIPS` | `2` | folder (zip) downloads one user can run at once |

## Sessions and security model

* **Login** creates a row in `sessions` (one per device/browser) and returns a **15-minute access token** (JWT,
  HS256, bound to that session) and sets a **refresh token** as an `httpOnly`, `SameSite=Strict` cookie scoped to
  `/api/auth` (JavaScript can never read it). The access token lives only in memory.
* The client renews the access token silently a minute before it expires. Each refresh **rotates** the refresh
  token. Replaying an old one outside a 15-second grace window (two tabs racing) is treated as theft and revokes
  the whole session. Tabs share one login (Web Locks + BroadcastChannel), so they never race.
* Every API request re-checks the session in the database, so **logout, "sign out other devices" and password
  change take effect immediately**; a Postgres trigger also pushes revocations to the gateway, which drops the
  socket at once. Sessions are listed and revocable in *Start → Settings → Sessions*.
* Files are served with a second, narrowly scoped `httpOnly` cookie (`/api/my` only, GET/HEAD only) so `<audio>`,
  `<img>` and downloads work; it can never authorise a write, so it cannot be used for CSRF. Uploaded HTML/SVG/JS
  is forced to download and sandboxed with CSP, so a user file can never act as the logged-in user.
* Passwords: bcrypt over `HMAC-SHA256(SALT, password)` (the legacy `password+SALT` scheme silently dropped the pepper
  past 72 bytes). Unknown user and wrong password are indistinguishable (same message, same timing). Login is
  rate limited per IP and per username. State-changing requests from a foreign `Origin` are refused. CORS is
  off unless `CORS_ORIGINS` is set (the old code reflected any origin together with credentials).
* Path handling: every path is normalised and confined to `<system>/users/<id>/root`, symlinks that point outside
  are refused, folder/system dirs (`documents`, `music`, …) cannot be deleted or renamed. The **terminal is virtual**:
  it implements its commands itself and never starts a process, so a terminal session cannot reach the host.
* Containers: non-root user, read-only root filesystem (api, socket), all capabilities dropped,
  `no-new-privileges`, db on an internal network with no route out and no published port, strict CSP in nginx.

## HTTP API (`/api`)

| | |
|---|---|
| `GET /health`, `/handcheck`, `/config`, `/wsockets` | public (`/wsockets` = gateways by priority) |
| `POST /auth/register`, `/auth/login` | → `{ user, accessToken, expiresIn, sessionId }` + cookies |
| `POST /auth/refresh`, `/auth/logout` | cookie (logout also accepts a bearer token) |
| `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `DELETE /auth/sessions` (others) | bearer |
| `POST /auth/password` | bearer; signs out the other devices |
| `GET /my/<path>` | file (HTTP Range supported); `?download` forces download, `?zip` zips a folder |
| `PUT /my/<path>` | upload (raw body, streamed); `?overwrite=1`, `?parents=1` |

Errors are `{ "message": "<slug>", "code": <http status> }`. Validation failures add `errors: [{path, message}]`.

## Websocket gateway (`/ws`)

Messages are `{ action, data, code, rid? }` (the server echoes `rid`). Same actions as before
(`connect`, `start_app`, `fetch_app`, `update_app`, `close_app`, `disconnect`, `goodbye`) plus `ping`, and server
pushes `event_<session>`. `connect` carries the access token and is simply re-sent when the token is renewed.
One bad message no longer kills the connection; there is a per-connection rate limit and a size limit.

Robustness rules of the gateway (all covered by tests):

* **Slow browsers cannot hurt anybody else.** Every connection has a bounded outbox drained by its own writer thread;
  one that falls too far behind is disconnected instead of stalling the event feed for every user.
* **Nothing unauthenticated lingers.** A socket must send `connect` within `WS_AUTH_TIMEOUT_SECONDS` (10), may only
  send small messages before that, and there is a cap on such sockets. Flooding is refused *before* messages are
  parsed, and a client that ignores `rate_limited` is disconnected.
* At `WS_MAX_CONNECTIONS_PER_USER` the user's **oldest** socket is replaced (a sleeping laptop never locks you out).
* If the Postgres event feed is interrupted, every open app is told to reload (`restore`): missed notifications
  are never silently lost. Oversized file-change notifications degrade to the same reload.
* `/healthz` answers 200 only when the database does; the database pool queues callers instead of failing, and
  replaces connections killed by a database restart.

Apps are registered in `socket/apps.xml` (same format as before): `explorer`, `music`, `codeEditor`, `terminalEmulator`.
Events (`fs_changed`, `playlists_changed`) are published per user, from other app sessions **and** from the HTTP API
(through Postgres `NOTIFY`), so every open Explorer/Code/Music window updates live, also when a file is uploaded.

In the browser: `const files = await document.wsscon.app('explorer'); await files.fetch('listdir', {path:'/'})`.
The old callback API (`connectApp`, `setRoute`, `onReady`) still exists.

## Apps

* **Explorer**: grid/list, breadcrumbs, places, new folder/file, rename (F2), delete, cut/copy/paste, drag & drop to
  move/copy, upload (picker, drag from the OS, whole folders), download file / folder as zip, image thumbnails,
  search, sort, hidden files, keyboard navigation, context menus, *Open with*, *Add to playlist*, *Play in Music*.
* **Music**: playlists (create, rename, delete, add songs from the library, reorder, remove) stored in Postgres;
  library scan; shuffle/repeat; volume memory; OS media keys via MediaSession; plays a file/folder sent by the Explorer.
* **Code**: tabs, syntax highlighting (JS, Python, C-like, JSON, HTML, CSS, Markdown, shell, SQL, config), auto-indent,
  auto-close pairs, comment toggle, find/replace, go to line, save with **conflict detection**, live reload when the
  file changes elsewhere, Python/JSON syntax check (never executes code), file tree, embedded terminal, restores open tabs.
* **Terminal**: virtual shell: `ls cd cat head tail grep find tree wc sort uniq mkdir touch rm cp mv stat du echo env
  history clear help`, pipes, `> >>`, `;` `&&`, tab completion, history, ANSI colours; `open`, `play`, `code` launch the apps.
* **Desktop**: windows (drag, resize, maximise, minimise, taskbar), start menu, desktop icons for apps and for the
  files in `/desktop`, rubber-band selection, connection indicator, Settings (account, sessions, connection),
  apps are downloaded lazily the first time they open.

Each app also runs on its own page (`/apps/explorer/`, …); `client/apps/registry.json` is the single list of apps and
of which file types open in which app.

## Desktop suite (real desktop)

`suite/` is an Electron app: launcher + tray, every app in its own native window (or the whole virtual desktop),
one shared sign-in, apps that cooperate (singleton Music/Code windows receive files from the Explorer), media keys.
It works on your **server-side** files; it does not touch the local disk. See [`suite/README.md`](suite/README.md).

## Database

`api/migrations/*.sql` (dbmate format: `-- migrate:up` / `-- migrate:down`), applied by the api itself at start-up
(`api/src/migrate.js`): one transaction per migration, an advisory lock (several replicas can start together),
checksums (editing an applied migration is refused) and a refusal to run against a database that is *ahead* of the
code. By hand: `npm run migrate` | `migrate:status` | `migrate:down -- 2` | `migrate:new -- add_something`
(from `api/`, with the usual `POSTGRES_*` / `DB_HOST` variables).

## Other sites and remote servers

Two directions, one idea each:

* **A page from another site uses this server** (`app.example.com` → this API and gateway): list its origin in
  `CORS_ORIGINS`. The API then answers its CORS requests, issues its cookies as `SameSite=None; Secure` (https only; same-site
  visitors keep `Strict`) and the gateway accepts its sockets. State-changing requests from any other origin are refused.
* **This client uses another server** (the login page's "Server" field): list that server in `CSP_REMOTE_SRC`,
  because the page's CSP otherwise blocks it (requests, and also the images and audio, which are loaded from the server's address).

Third-party-cookie blocking (Safari, Firefox strict mode, Chrome with the phase-out) breaks cross-site sessions, since
the refresh token is a cookie. Same-site deployments are unaffected.

## Front-end performance

Self-hosted woff2 fonts (Inter 875 KB TTF + Google Fonts `@import` → ~65 KB, preloaded, no third party); SVG icon
sprite; parallel resource loading with ordered script execution; per-app lazy loading; a build step
(`client/build.mjs`) that minifies, **content-hashes** every file (`?v=…`) and precompresses it, so nginx serves
`immutable, max-age=1y` for assets, `no-cache` for pages, and `gzip_static`.

## Development

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build   # exposes api/socket/db on localhost, serves ./client unbuilt
cd api && npm test            # needs a reachable Postgres (POSTGRES_* + DB_HOST); it migrates it itself
cd socket && python -m unittest tests.test_userfs tests.test_shell tests.test_gateway tests.test_database   # test_database needs the same Postgres variables
RATE_LIMITS=off ...  # start the stack with limits off first, or the test accounts trip the registration limit
API_URL=http://localhost:8000/api WS_URL=ws://localhost:8001 python -m unittest tests.test_e2e   # needs the running stack
```
