const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const { config } = require("../../config/env.js");

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, msg, extra) {
    if (LEVELS[level] < threshold)
        return;

    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });

    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

module.exports = {
    debug: (msg, extra) => write("debug", msg, extra),
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
};
