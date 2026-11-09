const { db } = require("../../config/db.js");
const log = require("../lib/logger.js");

const CHANNELS = { fs: "fs_events" };
const MAX_PAYLOAD_BYTES = 7000;

async function publish(channel, payload, client = db) {
    const text = JSON.stringify(payload);

    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES)
        throw new Error(`realtime payload too large (${Buffer.byteLength(text)} bytes)`);

    await client.query("SELECT pg_notify($1, $2)", [channel, text]);
}

async function fsChanged(userId, op, { dirs = [], files = [] } = {}, client = db) {
    let payload = { user: userId, op, dirs: [...new Set(dirs)], files: [...new Set(files)] };

    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES)
        payload = { user: userId, op, dirs: [], files: [], resync: true };

    try {
        await publish(CHANNELS.fs, payload, client);
    } catch (err) {
        log.warn("realtime notification failed", { channel: CHANNELS.fs, error: err.message });
    }
}

module.exports = { CHANNELS, publish, fsChanged };
