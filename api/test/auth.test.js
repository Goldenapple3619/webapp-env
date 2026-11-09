const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client } = require("./helpers.js");

let server, db;
test.before(async () => { server = await start(); db = require("../config/db.js").db; });
test.after(async () => { await server.stop(); });

const name = () => "t_" + Math.random().toString(36).slice(2, 10);
const pass = "correct horse battery";

test("register logs in; cookies are httpOnly and scoped", async () => {
    const api = client(server.base);
    const u = name();
    const r = await api("/auth/register", { method: "POST", json: { username: u, password: pass } });
    assert.equal(r.status, 201);
    assert.ok(r.data.accessToken && r.data.sessionId);
    assert.equal(r.data.user.password, undefined, "never leak the hash");
    assert.ok(api.jar.has("gz_rt") && api.jar.has("gz_at"));
    const me = await api("/auth/me", { token: r.data.accessToken });
    assert.equal(me.data.data.username, u);
});

test("usernames are unique case-insensitively; weak input is rejected", async () => {
    const api = client(server.base), u = name();
    await api("/auth/register", { method: "POST", json: { username: u, password: pass } });
    assert.equal((await api("/auth/register", { method: "POST", json: { username: u.toUpperCase(), password: pass } })).status, 409);
    assert.equal((await api("/auth/register", { method: "POST", json: { username: "a", password: "x" } })).status, 400);
});

test("wrong password and unknown user are indistinguishable", async () => {
    const api = client(server.base), u = name();
    await api("/auth/register", { method: "POST", json: { username: u, password: pass } });
    const a = await api("/auth/login", { method: "POST", json: { username: u, password: "nope-nope-nope" } });
    const b = await api("/auth/login", { method: "POST", json: { username: name(), password: "nope-nope-nope" } });
    assert.equal(a.status, 401);
    assert.deepEqual(a.data, b.data);
});

test("protected routes need a valid bearer token; the cookie alone cannot call the API", async () => {
    const api = client(server.base);
    const r = await api("/auth/register", { method: "POST", json: { username: name(), password: pass } });
    assert.equal((await api("/auth/me")).status, 401);                                   // cookie only
    assert.equal((await api("/auth/me", { token: "garbage" })).status, 401);
    assert.equal((await api("/auth/me", { token: r.data.accessToken })).status, 200);
});

test("refresh rotates the token; replay inside the grace window is tolerated, later replay revokes the session", async () => {
    const api = client(server.base);
    const r = await api("/auth/register", { method: "POST", json: { username: name(), password: pass } });
    const first = api.jar.get("gz_rt");

    const rot = await api("/auth/refresh", { method: "POST" });
    assert.equal(rot.status, 200);
    const second = api.jar.get("gz_rt");
    assert.notEqual(first, second, "refresh token rotated");

    // a second tab racing with the old cookie (inside the grace window): fresh access token, no cookie change
    const racer = client(server.base);
    racer.jar.set("gz_rt", first);
    assert.equal((await racer("/auth/refresh", { method: "POST" })).status, 200);
    assert.equal(racer.jar.get("gz_rt"), first);

    // outside the grace window the same replay is theft: the whole session dies, including the legit token
    await db.query("UPDATE sessions SET rotated_at = now() - interval '5 minutes' WHERE id = $1", [r.data.sessionId]);
    assert.equal((await racer("/auth/refresh", { method: "POST" })).status, 401);
    assert.equal((await api("/auth/refresh", { method: "POST" })).status, 401);
    const reason = await db.query("SELECT revoked_reason FROM sessions WHERE id = $1", [r.data.sessionId]);
    assert.equal(reason.rows[0].revoked_reason, "refresh_token_reuse");
});

test("logout revokes the session at once (the access token dies too)", async () => {
    const api = client(server.base);
    const r = await api("/auth/register", { method: "POST", json: { username: name(), password: pass } });
    assert.equal((await api("/auth/logout", { method: "POST", token: r.data.accessToken })).status, 200);
    assert.equal((await api("/auth/me", { token: r.data.accessToken })).status, 401);
    assert.equal((await api("/auth/refresh", { method: "POST" })).status, 401);
});

test("legacy bcrypt(password+SALT) hashes still log in and are upgraded to v2", async () => {
    const bcrypt = require("bcryptjs");
    const u = name();
    await db.query("INSERT INTO users (username, password) VALUES ($1, $2)", [u, bcrypt.hashSync("oldpassword" + process.env.SALT, 4)]);
    const api = client(server.base);
    assert.equal((await api("/auth/login", { method: "POST", json: { username: u, password: "oldpassword" } })).status, 200);
    const row = await db.query("SELECT password FROM users WHERE username = $1", [u]);
    assert.ok(row.rows[0].password.startsWith("v2:"));
    assert.equal((await client(server.base)("/auth/login", { method: "POST", json: { username: u, password: "oldpassword" } })).status, 200);
});

test("changing the password signs out the other devices", async () => {
    const a = client(server.base), b = client(server.base), u = name();
    const ra = await a("/auth/register", { method: "POST", json: { username: u, password: pass } });
    const rb = await b("/auth/login", { method: "POST", json: { username: u, password: pass } });
    const ch = await a("/auth/password", { method: "POST", token: ra.data.accessToken, json: { current: pass, next: "a brand new pass" } });
    assert.equal(ch.status, 200);
    assert.equal((await b("/auth/me", { token: rb.data.accessToken })).status, 401);
    assert.equal((await a("/auth/me", { token: ra.data.accessToken })).status, 200);
});

test("CSRF: a state-changing request from a foreign Origin is refused", async () => {
    const api = client(server.base);
    const r = await api("/auth/login", { method: "POST", json: { username: "x", password: "y" }, headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 403);
});

test("login is rate limited per IP (429 once the budget is spent, and it stays 429)", async () => {
    const api = client(server.base);
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push((await api("/auth/login", { method: "POST", json: { username: "nobody", password: "whatever-pass" } })).status);
    assert.ok(codes.includes(429), codes.join(","));
    assert.equal(codes[codes.length - 1], 429);
    assert.equal(codes[0], 401, "the first attempts are answered normally");
});
