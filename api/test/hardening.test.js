const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const pg = require("pg");
const { start, client } = require("./helpers.js");

let server, db, api;
const name = () => "h_" + Math.random().toString(36).slice(2, 10);
const pass = "correct horse battery";
const APP = "https://app.example.test"; // listed in CORS_ORIGINS by helpers.js

test.before(async () => {
    server = await start();
    db = require("../config/db.js").db;
    api = client(server.base);
});
test.after(async () => { await server.stop(); });

/** Runs a snippet in a fresh process with the given environment (config is read once, at require time). */
function inChild(code, env) {
    const base = { PATH: process.env.PATH, JWT_SECRET: "j".repeat(40), POSTGRES_USER: "u", POSTGRES_DB: "d", POSTGRES_PASSWORD: "p" };
    const run = spawnSync(process.execPath, ["-e", code], { cwd: path.join(__dirname, ".."), env: { ...base, ...env }, encoding: "utf8" });
    return { out: run.stdout.trim(), err: run.stderr.trim(), status: run.status };
}

async function register() {
    const a = client(server.base);
    const r = await a("/auth/register", { method: "POST", json: { username: name(), password: pass } });
    return { a, token: r.data.accessToken, id: r.data.user.id, sid: r.data.sessionId };
}

// ---- configuration ----------------------------------------------------------------------------------------------
test("config: junk values are reported, all at once, instead of silently becoming something else", () => {
    const run = inChild(`try { require("./config/env.js").validate(); } catch (e) { console.log(e.message); }`, {
        ACCESS_TOKEN_TTL: "15m", DB_POOL_SIZE: "10x", COOKIE_SECURE: "ture", CORS_ORIGINS: "https://ok.example, not-an-origin", BCRYPT_COST: "2", RATE_LIMITS: "maybe",
    });
    // DB_POOL_SIZE=10x is the telling one: parseInt() would happily read it as a perfectly valid 10.
    for (const expected of ["ACCESS_TOKEN_TTL must be an integer", "DB_POOL_SIZE must be an integer", "COOKIE_SECURE must be", "not-an-origin", "BCRYPT_COST must be an integer", "RATE_LIMITS must be"])
        assert.match(run.out, new RegExp(expected), `missing report for: ${expected}\n${run.out}`);
});

test("config: origins are normalised to what browsers send (no trailing slash, PUBLIC_URL included once)", () => {
    const run = inChild(`console.log(JSON.stringify(require("./config/env.js").config.cors.origins))`, {
        PUBLIC_URL: "https://site.example/app/", CORS_ORIGINS: "https://other.example/, https://site.example",
    });
    assert.deepEqual(JSON.parse(run.out), ["https://site.example", "https://other.example"]);
});

test("config: a session cannot outlive its own absolute limit", () => {
    const run = inChild(`try { require("./config/env.js").validate(); console.log("ok") } catch (e) { console.log(e.message) }`, { SESSION_TTL_DAYS: "60", SESSION_MAX_DAYS: "30" });
    assert.match(run.out, /SESSION_TTL_DAYS cannot exceed SESSION_MAX_DAYS/);
});

// ---- rate limiting ------------------------------------------------------------------------------------------------
test("rate limit: one IPv6 /64 is one client, not 2^64 of them", async () => {
    // limit is 12/min per address (helpers.js); every request below comes from a different address of the same /64
    const statuses = [];
    for (let i = 0; i < 16; i++) {
        const r = await api("/auth/login", { method: "POST", headers: { "x-forwarded-for": `2001:db8:feed:42::${i + 1}` }, json: { username: name(), password: "wrong-password" } });
        statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), `an IPv6 attacker rotating addresses was never limited: ${statuses}`);
});

test("rate limit: successful logins do not lock an account; failures do", async () => {
    const u = name();
    await api("/auth/register", { method: "POST", json: { username: u, password: pass } });
    // 35 good logins from distinct IPv4 addresses (so the per-IP limiter is out of the picture): all fine
    for (let i = 0; i < 35; i++) {
        const r = await api("/auth/login", { method: "POST", headers: { "x-forwarded-for": `198.51.100.${i + 1}` }, json: { username: u, password: pass } });
        assert.equal(r.status, 200, `login ${i + 1} refused`);
    }
    // ... but 31 wrong guesses (again from distinct addresses) shut the door
    let last;
    for (let i = 0; i < 31; i++) last = await api("/auth/login", { method: "POST", headers: { "x-forwarded-for": `203.0.113.${i + 1}` }, json: { username: u, password: "wrong-password" } });
    assert.equal(last.status, 429);
});

test("rate limit: changing the password is not a password-guessing oracle", async () => {
    const { a, token } = await register();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await a("/auth/password", { method: "POST", token, json: { current: "not-my-password", next: "another long password" } })).status);
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429, statuses.join(","));
});

// ---- headers + cross-site -----------------------------------------------------------------------------------------
test("API answers are never cached; file reads keep their own policy", async () => {
    const { a, token } = await register();
    assert.equal((await a("/auth/me", { token })).headers.get("cache-control"), "no-store");
    assert.equal((await a("/handcheck")).headers.get("cache-control"), "no-store");
    await a("/my/documents/c.txt", { method: "PUT", token, body: "x" });
    assert.equal((await a("/my/documents/c.txt", { token })).headers.get("cache-control"), "private, no-cache");
});

test("cross-site: an allow-listed page may call the API with credentials, any other page may not", async () => {
    const { a, token } = await register();
    const allowed = await a("/auth/me", { token, headers: { origin: APP } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), APP);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

    const foreign = await a("/auth/me", { token, headers: { origin: "https://evil.example.test" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(server.base + "/auth/login", { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "content-type, authorization" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), APP);
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
});

test("cross-site: state-changing requests from other origins are refused, even without an Origin header when the browser says cross-site", async () => {
    const post = (headers) => api("/auth/logout", { method: "POST", headers });
    assert.equal((await post({ origin: "https://evil.example.test" })).status, 403);
    assert.equal((await post({ origin: "null" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post({ origin: APP })).status, 200);
    assert.equal((await post({})).status, 200, "curl / native clients send no Origin and stay welcome");
    assert.equal((await post({ origin: new URL(server.base).origin })).status, 200, "same origin");
});

test("cross-site: cookies are strict, except SameSite=None;Secure for an allow-listed page over https", () => {
    const code = (req) => `
        const { setSessionCookies } = require("./src/services/cookies.js");
        const set = [];
        const res = { cookie: (n, v, o) => set.push([n, o.sameSite, o.secure]), clearCookie() {} };
        const req = ${req};
        setSessionCookies(req, res, { accessToken: "a", refreshToken: "r", session: { expiresAt: new Date(Date.now() + 1e6) } });
        console.log(JSON.stringify(set.map(([n, s, sec]) => [s, sec])));`;
    const mk = (origin, secure) => `{ secure: ${secure}, headers: { origin: ${JSON.stringify(origin)} }, get: () => "api.example.test" }`;
    const env = { CORS_ORIGINS: APP };
    const run = (origin, secure, extra = {}) => JSON.parse(inChild(code(mk(origin, secure)), { ...env, ...extra }).out)[0];

    assert.deepEqual(run(undefined, true), ["strict", true], "same-site page");
    assert.deepEqual(run(APP, true), ["none", true], "allow-listed page over https");
    assert.deepEqual(run(APP, false), ["strict", false], "None without Secure is rejected by browsers: stay strict");
    assert.deepEqual(run("https://evil.example.test", true), ["strict", true], "unknown page");
    assert.deepEqual(run(APP, true, { COOKIE_SAMESITE: "lax" }), ["lax", true], "an explicit setting wins");
});

// ---- migrations ----------------------------------------------------------------------------------------------------
test("migrations: re-running is a no-op; an edited applied migration and a database ahead of the code are refused", async () => {
    const { migrate, MIGRATIONS_DIR } = require("../src/migrate.js");
    assert.equal(await migrate(db, { log: () => {} }), 0);

    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(copy, f));

    const files = fs.readdirSync(copy).sort();
    fs.appendFileSync(path.join(copy, files[0]), "\n-- sneaky edit\n");
    await assert.rejects(migrate(db, { dir: copy, log: () => {} }), /was modified after being applied/);

    fs.copyFileSync(path.join(MIGRATIONS_DIR, files[0]), path.join(copy, files[0]));
    fs.rmSync(path.join(copy, files.at(-1)));
    await assert.rejects(migrate(db, { dir: copy, log: () => {} }), /no matching file exists/);
});

test("migrations: two runners at once never apply anything twice (advisory lock)", async () => {
    const { migrate } = require("../src/migrate.js");
    const results = await Promise.all([migrate(db, { log: () => {} }), migrate(db, { log: () => {} }), migrate(db, { log: () => {} })]);
    assert.deepEqual(results, [0, 0, 0]);
});

test("migrations: the session trigger announces live revocations but not the hourly purge", async () => {
    const listener = new pg.Client(db.pool.options);
    await listener.connect();
    const heard = [];
    listener.on("notification", (n) => heard.push(JSON.parse(n.payload)));
    await listener.query("LISTEN session_events");

    const { id, sid } = await register();
    const sessions = require("../src/services/sessions.js");
    await sessions.revoke(sid, id, "test");

    // sessions that ended long ago, then purged: silence
    await db.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at, revoked_at) VALUES ($1, $2, now() - interval '30 days', now() - interval '30 days')`, [id, crypto.randomBytes(8).toString("hex")]);
    await db.query(`INSERT INTO sessions (user_id, refresh_hash, expires_at) VALUES ($1, $2, now() - interval '30 days')`, [id, crypto.randomBytes(8).toString("hex")]);
    await new Promise((r) => setTimeout(r, 100));
    const before = heard.length;
    assert.ok(heard.some((h) => h.sid === sid), "revocation must be announced");
    assert.ok((await sessions.purge()) >= 2);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(heard.length, before, "purging dead sessions must not notify anybody");
    await listener.end();
});

// ---- DAO layer -------------------------------------------------------------------------------------------------------
test("db: transactions roll back, DAO helpers take a client, deletes need a WHERE", async () => {
    const { User } = require("../src/primitives/user.js");
    const tag = name();
    const mk = (i) => new User(`${tag}_${i}`, "hash");

    await assert.rejects(db.tx(async (client) => {
        await db.writeManyDAO("users", [mk(1), mk(2)], User, client);
        assert.equal(await db.countDAO("users", "WHERE username LIKE $1", [`${tag}_%`], client), 2);
        throw new Error("boom");
    }), /boom/);
    assert.equal(await db.countDAO("users", "WHERE username LIKE $1", [`${tag}_%`]), 0, "rolled back");

    const { data } = await db.writeManyDAO("users", [mk(1), mk(2), mk(3)], User);
    assert.equal(data.length, 3);
    const one = await db.getDAO("users", User, data[0].id);
    assert.equal(one.username, `${tag}_1`);
    assert.equal(await db.getDAO("users", User, 2147483647), null);

    one.password = "changed";
    assert.equal((await db.updateDAO("users", one, User)).password, "changed");
    assert.equal(await db.transaction(async () => "alias works"), "alias works");

    await assert.rejects(db.removeDAO("users", User, ""), /needs a WHERE/);
    assert.equal(await db.removeDAO("users", User, "WHERE username LIKE $1", [`${tag}_%`]), 3);
});

test("db: identifiers are never interpolated unchecked", async () => {
    await assert.rejects(db.countDAO("users; DROP TABLE users"), /Unsafe SQL identifier/);
});

// ---- files ---------------------------------------------------------------------------------------------------------------
test("upload: parents=1 can never create folders outside the user's root through a symlink", async () => {
    const { a, token, id } = await register();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.symlinkSync(outside, path.join(config().systemRoot, "users", String(id), "root", "documents", "portal"));

    const r = await a("/my/documents/portal/created/deep/f.txt?parents=1", { method: "PUT", token, body: "x" });
    assert.ok([404, 409].includes(r.status), `unexpected status ${r.status}`);
    assert.deepEqual(fs.readdirSync(outside), [], "something was created outside the root");

    const ok = await a("/my/documents/new/deep/f.txt?parents=1", { method: "PUT", token, body: "x" });
    assert.equal(ok.status, 201, "legitimate parents=1 keeps working");
    assert.equal((await a("/my/documents/new/deep/f.txt", { token })).text, "x");
});

test("upload: a half-written file is never visible in the user's tree, and too-large is a clean 413", async () => {
    const { a, token, id } = await register();
    await a("/my/documents/done.txt", { method: "PUT", token, body: "complete" });
    const root = path.join(config().systemRoot, "users", String(id), "root");
    const strays = fs.readdirSync(path.join(root, "documents")).filter((f) => f.startsWith(".upload-"));
    assert.deepEqual(strays, []);
    assert.deepEqual(fs.readdirSync(path.join(config().systemRoot, "users", String(id), "tmp")), [], "tmp is emptied after the move");

    const big = await a("/my/documents/big.bin", { method: "PUT", token, headers: { "content-length": String(config().maxUploadBytes + 1) }, body: "x" }).catch((e) => ({ status: "network:" + e.message }));
    assert.ok([413, "network:fetch failed"].includes(big.status), String(big.status));
});

test("scheduler: abandoned partial uploads are swept, fresh ones are left alone", async () => {
    const { id } = await register();
    const tmp = path.join(config().systemRoot, "users", String(id), "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const stale = path.join(tmp, "upload-old.part"), fresh = path.join(tmp, "upload-new.part");
    fs.writeFileSync(stale, "x"); fs.writeFileSync(fresh, "y");
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(stale, old, old);

    const { sweepUploads } = require("../src/services/scheduler.js");
    assert.ok((await sweepUploads()) >= 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
});

test("zip downloads: a user can only build a couple at once", async () => {
    const { token, id } = await register();
    const dir = path.join(config().systemRoot, "users", String(id), "root", "documents", "bulk");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `r${i}.bin`), crypto.randomBytes(3 * 1024 * 1024)); // incompressible: the response cannot finish unread

    const url = new URL(server.base + "/my/documents/bulk?zip");
    const open = () => new Promise((resolve) => {
        const req = http.get(url, { headers: { authorization: `Bearer ${token}` } }, (res) => { res.pause(); resolve({ res, req }); });
    });
    const held = [await open(), await open()];
    const third = await open();
    assert.equal(third.res.statusCode, 429, "third concurrent zip must be refused");
    for (const { req } of [...held, third]) req.destroy();
    await new Promise((r) => setTimeout(r, 300));

    const again = await open();
    assert.equal(again.res.statusCode, 200, "slots are released when downloads end");
    again.req.destroy();
});

// ---- realtime -----------------------------------------------------------------------------------------------------------------
test("realtime: file events reach LISTENers; oversized ones degrade to a resync instead of vanishing", async () => {
    const listener = new pg.Client(db.pool.options);
    await listener.connect();
    const heard = [];
    listener.on("notification", (n) => heard.push(JSON.parse(n.payload)));
    await listener.query("LISTEN fs_events");

    const { fsChanged } = require("../src/services/realtime.js");
    await fsChanged(7, "upload", { dirs: ["/a", "/a"], files: ["/a/b.txt"] });
    const many = Array.from({ length: 400 }, (_, i) => `/documents/folder-with-a-long-name-${i}/file-${i}.txt`);
    await fsChanged(7, "delete", { dirs: [], files: many });
    await new Promise((r) => setTimeout(r, 150));
    await listener.end();

    assert.deepEqual(heard[0], { user: 7, op: "upload", dirs: ["/a"], files: ["/a/b.txt"] });
    assert.deepEqual(heard[1], { user: 7, op: "delete", dirs: [], files: [], resync: true });
});

test("realtime: a notification that cannot be sent never fails the caller", async () => {
    const { fsChanged } = require("../src/services/realtime.js");
    const broken = { query: async () => { throw new Error("db down"); } };
    await assert.doesNotReject(fsChanged(1, "upload", { dirs: ["/"] }, broken));
});

function config() { return require("../config/env.js").config; }
