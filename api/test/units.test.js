process.env.JWT_SECRET ||= "t".repeat(48);
process.env.SALT = "pepper";
process.env.BCRYPT_COST = "4";
process.env.SYSTEM_ROOT = "/tmp/units-root";
const test = require("node:test");
const assert = require("node:assert/strict");
const passwords = require("../src/services/passwords.js");
const tokens = require("../src/services/tokens.js");
const userfs = require("../src/services/userfs.js");

test("v2 hashes keep the pepper even for very long passwords (bcrypt truncates at 72 bytes)", async () => {
    const long = "p".repeat(200);
    const h = await passwords.hash(long);
    assert.ok(h.startsWith("v2:"));
    assert.equal((await passwords.verify(long, h)).ok, true);
    assert.equal((await passwords.verify(long.slice(0, 199) + "q", h)).ok, false);
});

test("access tokens: sign / verify, tampering and wrong algorithm are rejected", () => {
    const t = tokens.signAccess({ userId: 7, sid: "abc" });
    assert.deepEqual({ ...tokens.verifyAccess(t), exp: 0 }, { userId: 7, sid: "abc", exp: 0 });
    assert.equal(tokens.verifyAccess(t.slice(0, -2) + "xx"), null);
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + t.split(".")[1] + ".";
    assert.equal(tokens.verifyAccess(none), null);
});

test("userfs.resolve cannot escape the root", () => {
    for (const evil of ["../../x", "/../../x", "a/../../../x", "..\\..\\x", "////../x"]) {
        const r = userfs.resolve(1, evil);
        assert.ok(r.abs === r.root || r.abs.startsWith(r.root + "/"), evil);
    }
    assert.throws(() => userfs.resolve(1, "a\0b"));
});
