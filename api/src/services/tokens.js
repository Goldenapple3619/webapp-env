const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { config } = require("../../config/env.js");

const AUDIENCE = "access";

function signAccess({ userId, sid }) {
    return jwt.sign({ sid }, config.auth.jwtSecret, {
        algorithm: "HS256",
        subject: String(userId),
        issuer: config.auth.issuer,
        audience: AUDIENCE,
        expiresIn: config.auth.accessTtl,
    });
}

function verifyAccess(token) {
    try {
        const p = jwt.verify(token, config.auth.jwtSecret, { algorithms: ["HS256"], issuer: config.auth.issuer, audience: AUDIENCE });

        if (typeof p.sid !== "string" || !p.sub)
            return null;

        return { userId: Number(p.sub), sid: p.sid, exp: p.exp };
    } catch {
        return null;
    }
}

const newRefreshToken = () => crypto.randomBytes(32).toString("base64url");
const hashRefreshToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

module.exports = { signAccess, verifyAccess, newRefreshToken, hashRefreshToken };
