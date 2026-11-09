const crypto = require("node:crypto");
const log = require("../src/lib/logger.js");

function requestLog(req, res, next) {
    const start = process.hrtime.bigint();
    req.id = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    res.on("finish", () => {
        if (req.path === "/api/health") return;
        log.info("request", {
            id: req.id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
            user: req.user?.id,
            ip: req.ip,
        });
    });
    next();
}

module.exports = { stage: "pre", middlewares: [{ callback: requestLog }] };
