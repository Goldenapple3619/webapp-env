const log = require("../src/lib/logger.js");
const { HttpError } = require("../src/lib/errors.js");

function notFound(_req, res) {
    res.status(404).json({ message: "not_found", code: 404 });
}

function errorHandler(err, req, res, _next) {
    if (res.headersSent)
        return res.destroy(err);

    if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message, code: err.status, ...(err.details ? { errors: err.details } : {}) });
    }

    if (err?.type === "entity.too.large")
        return res.status(413).json({ message: "payload_too_large", code: 413 });

    if (err?.type === "entity.parse.failed")
        return res.status(400).json({ message: "invalid_json", code: 400 });

    log.error("unhandled error", { id: req.id, path: req.path, error: err?.stack || String(err) });
    res.status(500).json({ message: "internal_error", code: 500 });
}

module.exports = { stage: "post", middlewares: [{ callback: notFound }, { callback: errorHandler }] };
