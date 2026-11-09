#!/usr/bin/env node

const { config } = require("../config/env.js");
const { DB } = require("../src/db.js");
const migrations = require("../src/migrate.js");

async function main() {
    const [cmd = "up", arg] = process.argv.slice(2);

    if (cmd === "new")
        return console.log(`[migrate] created ${require("node:path").relative(process.cwd(), migrations.scaffold(arg))}`);

    if (!["up", "down", "status"].includes(cmd))
        throw new Error(`unknown command '${cmd}' (up | down | status | new)`);

    const db = new DB(config.db);

    try {
        await db.connect({ attempts: Number(process.env.DB_WAIT_SECONDS || 60), delayMs: 1000 });

        if (cmd === "up")
            console.log(`[migrate] ${(await migrations.migrate(db)) || "no"} migration(s) applied`);

        if (cmd === "down")
            await migrations.rollback(db, Math.max(1, Number(arg) || 1));

        if (cmd === "status")
            for (const m of await migrations.status(db)) console.log(`${m.applied ? "applied " : "pending "} ${m.file}${m.applied ? `  (${m.appliedAt.toISOString()})` : ""}`);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(`[migrate] FAILED: ${err.message}`);
    process.exit(1);
});
