const { config } = require("../../config/env.js");

const ALLOWED = new Set(config.cors.origins);

const isAllowedOrigin = (origin) => typeof origin === "string" && ALLOWED.has(origin);

function hostOf(origin) {
    try {
        return new URL(origin).host;
    } catch {
        return null;
    }
}

const isSameSite = (req) => {
    const origin = req.headers.origin;

    return !origin || hostOf(origin) === req.get("host");
};

const isAllowedCrossSite = (req) => {
    const origin = req.headers.origin;

    return isAllowedOrigin(origin) && !isSameSite(req);
};

module.exports = { isAllowedOrigin, isSameSite, isAllowedCrossSite, hostOf };
