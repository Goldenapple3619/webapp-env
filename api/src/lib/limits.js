const rateLimit = require("express-rate-limit");
const { config } = require("../../config/env.js");
const { ipKeyGenerator } = rateLimit;

const byIp = (req) => ipKeyGenerator(req.ip);
const tooMany = { message: "too_many_attempts", code: 429 };

const make = (options) =>
    rateLimit({
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: tooMany,
        keyGenerator: byIp,
        ...options,
        skip: (req, res) => !config.rateLimit.enabled || (options.skip ? options.skip(req, res) : false),
    });

const global = make({
    windowMs: 60_000,
    limit: config.rateLimit.globalPerMinute,
    message: { message: "too_many_requests", code: 429 },
    skip: (req) => req.path === "/health" || (["GET", "HEAD"].includes(req.method) && (req.path === "/my" || req.path.startsWith("/my/"))),
});

const login = make({ windowMs: 60_000, limit: config.rateLimit.loginPerMinute });

const loginByName = make({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `u:${String(req.body?.username || "").trim().toLowerCase()}`,
});

const register = make({ windowMs: 60 * 60_000, limit: config.rateLimit.registerPerHour });

const sensitive = make({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `uid:${req.user?.id ?? "anonymous"}`,
});

module.exports = { global, login, loginByName, register, sensitive };
