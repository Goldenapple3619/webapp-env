const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { start, client } = require("./helpers.js");

let server, api, token, userId;
test.before(async () => {
    server = await start();
    api = client(server.base);
    const r = await api("/auth/register", { method: "POST", json: { username: "f_" + Math.random().toString(36).slice(2, 9), password: "correct horse battery" } });
    token = r.data.accessToken; userId = r.data.user.id;
});
test.after(async () => { await server.stop(); });

test("upload, download (bearer and cookie), range, overwrite protection", async () => {
    const put = await api("/my/documents/a.txt", { method: "PUT", token, body: "0123456789" });
    assert.equal(put.status, 201);
    assert.equal((await api("/my/documents/a.txt", { method: "PUT", token, body: "x" })).status, 409);
    assert.equal((await api("/my/documents/a.txt?overwrite=1", { method: "PUT", token, body: "0123456789" })).status, 201);
    assert.equal((await api("/my/documents/a.txt", { token })).text, "0123456789");
    assert.equal((await api("/my/documents/a.txt")).text, "0123456789", "scoped cookie authenticates GET (for <audio>/<img>)");
    const range = await api("/my/documents/a.txt", { headers: { range: "bytes=2-4" } });
    assert.equal(range.status, 206);
    assert.equal(range.text, "234");
});

test("the cookie never authorises writes", async () => {
    assert.equal((await api("/my/documents/evil.txt", { method: "PUT", body: "x" })).status, 401);
});

test("path traversal never leaves the user's root", async () => {
    for (const evil of ["../../../../etc/passwd", "..%2f..%2f..%2fetc/passwd", "%2e%2e/%2e%2e/etc/passwd", "documents/../../../etc/passwd"]) {
        const r = await fetch(`${server.base}/my/${evil}`, { headers: { authorization: `Bearer ${token}` } });
        assert.ok([400, 404].includes(r.status), `${evil} -> ${r.status}`);
        assert.ok(!(await r.text()).includes("root:"), evil);
    }
    assert.equal((await api("/my/a%00b", { token })).status, 400, "NUL bytes are rejected outright");
});

test("symlinks pointing outside the root are not followed", async () => {
    const { userRoot } = require("../src/services/userfs.js");
    const link = path.join(userRoot(userId), "documents", "escape");
    fs.symlinkSync("/etc", link);
    assert.equal((await api("/my/documents/escape/passwd", { token })).status, 404);
});

test("active content is neutralised, folders download as zip", async () => {
    await api("/my/documents/x.html", { method: "PUT", token, body: "<script>alert(1)</script>" });
    const r = await api("/my/documents/x.html");
    assert.match(r.headers.get("content-disposition"), /attachment/);
    assert.match(r.headers.get("content-security-policy"), /sandbox/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const z = await fetch(`${server.base}/my/documents?zip`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(z.status, 200);
    assert.equal((await z.arrayBuffer()).byteLength > 100, true);
    assert.equal((await api("/my/documents", { token })).status, 400, "a folder without ?zip is refused");
});
