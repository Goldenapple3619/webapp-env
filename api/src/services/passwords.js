const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { config } = require("../../config/env.js");

let dummy = null;

const prehash = (password) => crypto.createHmac("sha256", config.auth.pepper).update(password).digest("base64");

async function hash(password) {
    return "v2:" + (await bcrypt.hash(prehash(password), config.auth.bcryptCost));
}

async function verify(password, stored) {
    if (stored.startsWith("v2:"))
        return { ok: await bcrypt.compare(prehash(password), stored.slice(3)), needsRehash: false };

    const ok = await bcrypt.compare(password + config.auth.pepper, stored);

    return { ok, needsRehash: ok };
}

async function verifyDummy(password) {
    dummy ??= await hash(crypto.randomBytes(16).toString("hex"));
    await bcrypt.compare(prehash(password), dummy.slice(3));
}

module.exports = { hash, verify, verifyDummy };
