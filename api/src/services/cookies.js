const { config } = require("../../config/env.js");
const { isAllowedCrossSite } = require("../lib/origin.js");

const REFRESH_COOKIE = "gz_rt";
const ACCESS_COOKIE = "gz_at";
const REFRESH_PATH = `${config.cookies.pathPrefix}/auth`;
const ACCESS_PATH = `${config.cookies.pathPrefix}/my`;

const isSecure = (req) => (config.cookies.secure === "auto" ? req.secure : config.cookies.secure);

function sameSiteFor(req) {
    if (config.cookies.sameSite !== "auto")
        return config.cookies.sameSite;

    return isAllowedCrossSite(req) && isSecure(req) ? "none" : "strict";
}

const base = (req) => ({ httpOnly: true, secure: isSecure(req), sameSite: sameSiteFor(req) });

function setSessionCookies(req, res, { accessToken, refreshToken, session }) {
    res.cookie(ACCESS_COOKIE, accessToken, { ...base(req), path: ACCESS_PATH, maxAge: config.auth.accessTtl * 1000 });
    if (refreshToken) {
        res.cookie(REFRESH_COOKIE, refreshToken, {
            ...base(req),
            path: REFRESH_PATH,
            maxAge: Math.max(0, new Date(session.expiresAt).getTime() - Date.now()),
        });
    }
}

function clearSessionCookies(req, res) {
    res.clearCookie(ACCESS_COOKIE, { ...base(req), path: ACCESS_PATH });
    res.clearCookie(REFRESH_COOKIE, { ...base(req), path: REFRESH_PATH });
}

module.exports = { setSessionCookies, clearSessionCookies, REFRESH_COOKIE, ACCESS_COOKIE };
