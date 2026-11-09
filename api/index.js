const { validate, config } = require("./config/env.js");

try {
    validate();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

const { db } = require("./config/db.js");
const { app } = require("./config/app.js");
const { migrate } = require("./src/migrate.js");
const scheduler = require("./src/services/scheduler.js");
const log = require("./src/lib/logger.js");

async function main() {
    await db.connect().catch((err) => {
        log.error("failed to connect to db", { error: String(err.err?.message || err.err) });
        process.exit(1);
    });
    log.info("connected to db");

    const applied = await migrate(db, { log: (line) => log.info(line.replace(/^\[\*\] /, "")) }).catch((err) => {
        log.error("migration failed", { error: err.message });
        process.exit(1);
    });
    log.info("database schema is up to date", { applied });

    await app.connect().catch((err) => {
        log.error("failed to listen", { error: String(err.err?.message || err.err) });
        process.exit(1);
    });
    log.info("api listening", { port: app._server.address().port });

    const jobs = scheduler.start();

    let stopping = false;

    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        log.info("shutting down", { signal });
        setTimeout(() => process.exit(1), 10_000).unref();
        jobs.stop();
        await app.close();
        await db.close();
        process.exit(0);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason?.stack || reason) }));
main();
