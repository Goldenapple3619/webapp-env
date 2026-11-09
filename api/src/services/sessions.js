const { db } = require("../../config/db.js");
const { config } = require("../../config/env.js");
const { Session } = require("../primitives/session.js");
const { newRefreshToken, hashRefreshToken } = require("./tokens.js");

const DAY = "interval '1 day'";
const slidingExpiry = `LEAST(now() + ${config.auth.sessionDays} * ${DAY}, created_at + ${config.auth.sessionMaxDays} * ${DAY})`;

async function create({ userId, ip, userAgent }) {
    const refreshToken = newRefreshToken();
    const { rows } = await db.query(
        `INSERT INTO sessions (user_id, refresh_hash, user_agent, ip, expires_at)
         VALUES ($1, $2, $3, $4, now() + ${config.auth.sessionDays} * ${DAY}) RETURNING *`,
        [userId, hashRefreshToken(refreshToken), (userAgent || "").slice(0, 300), ip || null]
    );

    await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'too_many_sessions'
          WHERE id IN (SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
                       ORDER BY last_used_at DESC OFFSET $2)`,
        [userId, config.auth.maxSessionsPerUser]
    );
    return { session: new Session(rows[0]), refreshToken };
}

function rotate(presented, { ip, userAgent }) {
    const hash = hashRefreshToken(presented);

    return db.transaction(async (client) => {
        const current = await client.query(
            `SELECT * FROM sessions WHERE refresh_hash = $1 FOR UPDATE`, [hash]);
        const row = current.rows[0];

        if (row) {
            const alive = await client.query(
                `SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
                    AND created_at + ${config.auth.sessionMaxDays} * ${DAY} > now()`, [row.id]);

            if (!alive.rowCount)
                return null;

            const next = newRefreshToken();
            const updated = await client.query(
                `UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = now(),
                        last_used_at = now(), expires_at = ${slidingExpiry}, ip = COALESCE($3, ip), user_agent = COALESCE(NULLIF($4, ''), user_agent)
                  WHERE id = $1 RETURNING *`,
                [row.id, hashRefreshToken(next), ip || null, (userAgent || "").slice(0, 300)]
            );

            return { session: new Session(updated.rows[0]), refreshToken: next };
        }

        const replay = await client.query(`SELECT * FROM sessions WHERE prev_refresh_hash = $1 FOR UPDATE`, [hash]);
        const old = replay.rows[0];

        if (!old || old.revoked_at)
            return null;

        const age = (Date.now() - new Date(old.rotated_at).getTime()) / 1000;

        if (age <= config.auth.refreshGraceSeconds)
            return { session: new Session(old), refreshToken: null };

        await client.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse' WHERE id = $1`, [old.id]);

        return null;
    });
}

async function findActive(sid) {
    const { rows } = await db.query(
        `SELECT s.id AS sid, s.expires_at, u.id AS user_id, u.username
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sid]);
    return rows[0] || null;
}

async function findByRefresh(token) {
    const { rows } = await db.query(`SELECT id, user_id FROM sessions WHERE refresh_hash = $1 AND revoked_at IS NULL`, [hashRefreshToken(token)]);
    return rows[0] || null;
}

async function listForUser(userId) {
    const { rows } = await db.query(
        `SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`, [userId]);
    return rows.map((r) => new Session(r));
}

async function revoke(sid, userId, reason = "logout") {
    const { rowCount } = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sid, userId, reason]);
    return rowCount > 0;
}

async function revokeOthers(userId, exceptSid, reason = "revoked_by_user") {
    const { rowCount } = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, exceptSid, reason]);
    return rowCount;
}

/** Housekeeping: forget sessions that ended more than a week ago. */
async function purge() {
    const { rowCount } = await db.query(
        `DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
    return rowCount;
}

module.exports = { create, rotate, findActive, findByRefresh, listForUser, revoke, revokeOthers, purge };
