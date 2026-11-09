// Integration tests need a reachable Postgres (same variables as the app; it is migrated here) and the secrets below.
process.env.JWT_SECRET ||= "t".repeat(48);
process.env.SALT ||= "test-pepper";
process.env.API_INTERNAL_PORT = "0";           // ephemeral port
process.env.COOKIE_SECURE = "false";
process.env.LOG_LEVEL = "error";
process.env.BCRYPT_COST = "4";                  // fast hashes in tests
process.env.CORS_ORIGINS = "https://app.example.test"; // a page served from elsewhere that may use the API
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "1000";
process.env.RATE_LIMIT_LOGIN_PER_MINUTE = "12";   // the dedicated limiter test below exceeds it on purpose
process.env.SYSTEM_ROOT ||= require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "webapp-env-test-"));

let started = null;
async function start() {
    if (started) return started;
    const { db } = require("../config/db.js");
    const { app } = require("../config/app.js");
    const { migrate } = require("../src/migrate.js");
    await db.connect({ attempts: 3, delayMs: 300 });
    await migrate(db, { log: () => {} });
    await app.connect();
    const base = `http://127.0.0.1:${app._server.address().port}/api`;
    started = { base, stop: async () => { await app.close(); await db.close(); started = null; } };
    return started;
}

/** tiny cookie-aware fetch wrapper */
function client(base) {
    const jar = new Map();
    const api = async (path, { method = "GET", json, body, token, headers = {} } = {}) => {
        const h = { ...headers };
        if (json !== undefined) h["content-type"] = "application/json";
        if (token) h.authorization = `Bearer ${token}`;
        if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(";");
            const [k, ...v] = pair.split("=");
            if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v.join("="));
        }
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* binary or empty */ }
        return { status: res.status, data, text, headers: res.headers, cookies: Object.fromEntries(jar) };
    };
    api.jar = jar;
    return api;
}

module.exports = { start, client };
