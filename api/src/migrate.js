const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const LOCK_ID = 727274;
const FILE_RE = /^(\d{8,17})_([a-z0-9_]+)\.sql$/;

function parseMigration(sql) {
    const up = /^--\s*migrate:up\b.*$/m.exec(sql);

    if (!up)
        throw new Error("missing '-- migrate:up' marker");

    const down = /^--\s*migrate:down\b.*$/m.exec(sql);

    if (down && down.index < up.index)
        throw new Error("'-- migrate:down' must come after '-- migrate:up'");

    return {
        up: sql.slice(up.index + up[0].length, down ? down.index : undefined).trim(),
        down: down ? sql.slice(down.index + down[0].length).trim() : "",
    };
}

function loadFiles(dir = MIGRATIONS_DIR) {
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((file) => {
            const m = FILE_RE.exec(file);
            if (!m) throw new Error(`bad migration filename '${file}' (expected <timestamp>_<snake_name>.sql)`);
            const raw = fs.readFileSync(path.join(dir, file), "utf8");
            return { version: m[1], name: m[2], file, checksum: crypto.createHash("sha256").update(raw).digest("hex"), ...parseMigration(raw) };
        });
}

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
}

async function applied(client) {
    const { rows } = await client.query("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");

    return new Map(rows.map((r) => [r.version, r]));
}

function verify(files, done) {
    for (const f of files) {
        const row = done.get(f.version);

        if (row && row.checksum !== f.checksum)
            throw new Error(`migration ${f.file} was modified after being applied; create a new migration instead`);
    }

    const known = new Set(files.map((f) => f.version));

    for (const v of done.keys()) if (!known.has(v))
        throw new Error(`database has migration ${v} but no matching file exists (older code version?)`);
}

async function inTx(client, work) {
    await client.query("BEGIN");

    try {
        await work();
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    }
}

async function locked(db, dir, work) {
    const files = loadFiles(dir);
    const client = await db.pool.connect();

    try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
        await ensureTable(client);

        return await work(client, files);
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
        client.release();
    }
}

function migrate(db, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
    return locked(db, dir, async (client, files) => {
        const done = await applied(client);

        verify(files, done);

        const pending = files.filter((f) => !done.has(f.version));

        for (const f of pending) {
            log(`[*] Applying migration ${f.file}.`);

            try {
                await inTx(client, async () => {
                    if (f.up)
                        await client.query(f.up);

                    await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [f.version, f.name, f.checksum]);
                });
            } catch (err) {
                throw new Error(`Migration ${f.file} failed: ${err.message}`);
            }
        }
        return pending.length;
    });
}

function rollback(db, count = 1, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
    return locked(db, dir, async (client, files) => {
        const done = await applied(client);

        verify(files, done);

        const targets = files.filter((f) => done.has(f.version)).reverse().slice(0, count);

        for (const f of targets) {
            if (!f.down)
                throw new Error(`${f.file} has no '-- migrate:down' section`);

            log(`[*] Rolling back ${f.file}.`);

            await inTx(client, async () => {
                await client.query(f.down);
                await client.query("DELETE FROM schema_migrations WHERE version = $1", [f.version]);
            });
        }

        return targets.map((f) => f.file);
    });
}

function status(db, { dir = MIGRATIONS_DIR } = {}) {
    return locked(db, dir, async (client, files) => {
        const done = await applied(client);
        verify(files, done);
        return files.map((f) => ({ file: f.file, applied: done.has(f.version), appliedAt: done.get(f.version)?.applied_at ?? null }));
    });
}

function scaffold(name, { dir = MIGRATIONS_DIR } = {}) {
    if (!name || !/^[a-z0-9_]+$/.test(name))
        throw new Error("usage: npm run migrate:new -- <snake_case_name>");

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const file = path.join(dir, `${stamp}_${name}.sql`);

    fs.writeFileSync(file, "-- migrate:up\n\n\n-- migrate:down\n\n", { flag: "wx" });

    return file;
}

module.exports = { migrate, rollback, status, scaffold, parseMigration, loadFiles, MIGRATIONS_DIR };
