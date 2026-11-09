const fs = require("node:fs");
const path = require("node:path");
const sessions = require("./sessions.js");
const userfs = require("./userfs.js");
const log = require("../lib/logger.js");

const HOUR = 3600 * 1000;

async function sweepUploads(maxAgeMs = 24 * HOUR) {
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    const users = await fs.promises.readdir(path.join(userfs.systemUsersDir()), { withFileTypes: true }).catch(() => []);

    for (const user of users) {
        if (!user.isDirectory())
            continue;

        const dir = path.join(userfs.systemUsersDir(), user.name, "tmp");

        for (const entry of await fs.promises.readdir(dir).catch(() => [])) {
            const file = path.join(dir, entry);
            const stat = await fs.promises.stat(file).catch(() => null);

            if (stat?.isFile() && stat.mtimeMs < cutoff)
                removed += (await fs.promises.rm(file, { force: true }).then(() => 1, () => 0));
        }
    }
    return removed;
}

function start({ everyMs = HOUR } = {}) {
    let running = false;

    const tick = async () => {
        if (running)
            return;

        running = true;

        try {
            const purged = await sessions.purge();

            if (purged)
                log.info("purged old sessions", { count: purged });
        } catch (err) {
            log.warn("scheduler: session purge failed", { error: err.message });
        }
        try {
            const removed = await sweepUploads();

            if (removed)
                log.info("removed abandoned partial uploads", { count: removed });
        } catch (err) {
            log.warn("scheduler: upload sweep failed", { error: err.message });
        } finally {
            running = false;
        }
    };

    const timer = setInterval(tick, everyMs);
    timer.unref();
    tick();

    return { stop: () => clearInterval(timer), tick };
}

module.exports = { start, sweepUploads };
