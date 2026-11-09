const { verifyAccess } = require("../src/services/tokens.js");
const sessions = require("../src/services/sessions.js");
const { unauthorized } = require("../src/lib/errors.js");
const { ACCESS_COOKIE } = require("../src/services/cookies.js");

function authenticate({ allowCookie = false } = {}) {
    return async (req, _res, next) => {
        let token = null;
        const header = req.headers.authorization;

        if (header && /^Bearer /i.test(header))
            token = header.slice(7).trim();
        else if (allowCookie && ["GET", "HEAD"].includes(req.method))
            token = req.cookies?.[ACCESS_COOKIE] || null;

        if (!token)
            throw unauthorized();

        const claims = verifyAccess(token);

        if (!claims)
            throw unauthorized("token_invalid_or_expired");

        const row = await sessions.findActive(claims.sid);

        if (!row || row.user_id !== claims.userId)
            throw unauthorized("session_revoked");

        req.user = { id: row.user_id, username: row.username };
        req.session = { id: row.sid, expiresAt: row.expires_at, tokenExp: claims.exp };

        next();
    };
}

module.exports = { authenticate, ACCESS_COOKIE };
