const { z } = require("zod");

const { db } = require("../config/db.js");
const { config } = require("../config/env.js");
const { User } = require("../src/primitives/user.js");
const passwords = require("../src/services/passwords.js");
const tokens = require("../src/services/tokens.js");
const sessions = require("../src/services/sessions.js");
const userfs = require("../src/services/userfs.js");
const { setSessionCookies, clearSessionCookies, REFRESH_COOKIE } = require("../src/services/cookies.js");
const { validate } = require("../src/lib/validate.js");
const limits = require("../src/lib/limits.js");
const { HttpError, unauthorized, conflict } = require("../src/lib/errors.js");

const credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
const registration = z.object({
    username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '_', '.' and '-' only"),
    password: z.string().min(8, "at least 8 characters").max(128),
});
const passwordChange = z.object({ current: z.string().min(1).max(128), next: z.string().min(8, "at least 8 characters").max(128) });

const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

async function findUserByName(username) {
    const { data } = await db.requestDAO("users", User, "WHERE lower(username) = lower($1)", [username]);

    return data[0] || null;
}

function respondSession(req, res, { user, session, refreshToken, status = 200, message = "session_ok" }) {
    const accessToken = tokens.signAccess({ userId: user.id, sid: session.id });

    setSessionCookies(req, res, { accessToken, refreshToken, session });
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({
        message,
        code: status,
        user: user.toPublic(),
        accessToken,
        tokenType: "Bearer",
        expiresIn: config.auth.accessTtl,
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt,
    });
}

async function register(req, res) {
    if (!config.auth.allowRegistration)
        throw new HttpError(403, "registration_disabled");

    const { username, password } = req.body;

    if (await findUserByName(username))
        throw conflict("username_taken");

    let user;

    try {
        const created = await db.writeDAO("users", new User(username, await passwords.hash(password)), User);

        user = created.data[0];
    } catch (err) {
        if (err.code === "23505")
            throw conflict("username_taken");

        throw err;
    }

    userfs.ensureUser(user.id);

    const { session, refreshToken } = await sessions.create({ userId: user.id, ...clientInfo(req) });

    respondSession(req, res, { user, session, refreshToken, status: 201, message: "user_creation_ok" });
}

async function login(req, res) {
    const { username, password } = req.body;
    const user = await findUserByName(username);

    if (!user) {
        await passwords.verifyDummy(password);
        throw unauthorized("session_ko");
    }

    const { ok, needsRehash } = await passwords.verify(password, user.password);

    if (!ok)
        throw unauthorized("session_ko");

    await db.query(
        `UPDATE users SET last_login_at = now(), password = COALESCE($2, password) WHERE id = $1`,
        [user.id, needsRehash ? await passwords.hash(password) : null]
    );
    userfs.ensureUser(user.id);

    const { session, refreshToken } = await sessions.create({ userId: user.id, ...clientInfo(req) });

    respondSession(req, res, { user, session, refreshToken });
}

async function refresh(req, res) {
    const presented = req.cookies?.[REFRESH_COOKIE];

    if (!presented)
        throw unauthorized("no_refresh_token");

    const result = await sessions.rotate(presented, clientInfo(req));

    if (!result) {
        clearSessionCookies(req, res);
        throw unauthorized("session_expired");
    }

    const user = await db.getDAO("users", User, result.session.userId);

    if (!user) {
        clearSessionCookies(req, res);
        throw unauthorized("session_expired");
    }

    respondSession(req, res, { user, session: result.session, refreshToken: result.refreshToken, message: "refresh_ok" });
}

async function logout(req, res) {
    let sid = null;
    let userId = null;

    const header = req.headers.authorization;
    const claims = header && /^Bearer /i.test(header) ? tokens.verifyAccess(header.slice(7).trim()) : null;

    if (claims)
        ({ sid, userId } = claims);
    else if (req.cookies?.[REFRESH_COOKIE]) {
        const row = await sessions.findByRefresh(req.cookies[REFRESH_COOKIE]);

        if (row)
            ({ id: sid, user_id: userId } = row);
    }

    if (sid)
        await sessions.revoke(sid, userId, "logout");

    clearSessionCookies(req, res);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ message: "logout_ok", code: 200 });
}

async function me(req, res) {
    const user = await db.getDAO("users", User, req.user.id);

    if (!user)
        throw unauthorized("session_revoked");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
        message: "token_ok",
        code: 200,
        data: user.toPublic(),
        session: { id: req.session.id, expiresAt: req.session.expiresAt, tokenExpiresAt: req.session.tokenExp * 1000 },
    });
}

async function listSessions(req, res) {
    const list = await sessions.listForUser(req.user.id);

    res.status(200).json({ message: "sessions_ok", code: 200, sessions: list.map((s) => s.toPublic(req.session.id)) });
}

async function revokeSession(req, res) {
    const revoked = await sessions.revoke(req.params.id, req.user.id, req.params.id === req.session.id ? "logout" : "revoked_by_user");

    if (!revoked)
        throw new HttpError(404, "not_found");
    if (req.params.id === req.session.id)
        clearSessionCookies(req, res);
    res.status(200).json({ message: "session_revoked", code: 200 });
}

async function revokeOtherSessions(req, res) {
    const count = await sessions.revokeOthers(req.user.id, req.session.id);

    res.status(200).json({ message: "sessions_revoked", code: 200, revoked: count });
}

async function changePassword(req, res) {
    const user = await db.getDAO("users", User, req.user.id);

    if (!user)
        throw unauthorized("session_revoked");

    const { ok } = await passwords.verify(req.body.current, user.password);

    if (!ok)
        throw unauthorized("wrong_password");

    await db.query("UPDATE users SET password = $2, updated_at = now() WHERE id = $1", [req.user.id, await passwords.hash(req.body.next)]);

    const revoked = await sessions.revokeOthers(req.user.id, req.session.id, "password_changed");

    res.status(200).json({ message: "password_changed", code: 200, revoked });
}

module.exports = {routes: [
    { method: "post", path: "/auth/register", protected: false, limit: "register", middleware: [validate(registration)], callback: register },
    { method: "post", path: "/auth/login", protected: false, middleware: [limits.login, validate(credentials), limits.loginByName], callback: login },
    { method: "post", path: "/auth/refresh", protected: false, callback: refresh },
    { method: "post", path: "/auth/logout", protected: false, callback: logout },
    { method: "get", path: "/auth/me", protected: true, callback: me },
    { method: "get", path: "/auth/sessions", protected: true, callback: listSessions },
    { method: "delete", path: "/auth/sessions", protected: true, callback: revokeOtherSessions },
    { method: "delete", path: "/auth/sessions/:id", protected: true, callback: revokeSession },
    { method: "post", path: "/auth/password", protected: true, limit: "sensitive", middleware: [validate(passwordChange)], callback: changePassword },
]};
