const { db } = require("../config/db.js");
const { config } = require("../config/env.js");

function handcheckStatus(_req, res) {
    res.status(200).json({ message: "handcheck_ok", code: 200 });
}

async function health(_req, res) {
    try {
        await db.query("SELECT 1");
        res.status(200).json({ status: "ok", code: 200 });
    } catch {
        res.status(503).json({ status: "db_unreachable", code: 503 });
    }
}

function publicConfig(_req, res) {
    res.status(200).json({ message: "config_ok", code: 200, registration: config.auth.allowRegistration, accessTtl: config.auth.accessTtl });
}

module.exports = {
    routes: [
        { method: "get", path: "/handcheck", protected: false, callback: handcheckStatus },
        { method: "get", path: "/health", protected: false, callback: health },
        { method: "get", path: "/config", protected: false, callback: publicConfig },
    ],
};
