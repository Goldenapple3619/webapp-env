const pg = require("pg");

pg.types.setTypeParser(20, (value) => (Number.isSafeInteger(Number(value)) ? Number(value) : value));

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name) {
    if (typeof name !== "string" || !IDENTIFIER.test(name))
        throw new Error(`Unsafe SQL identifier '${name}'.`);

    return name;
}

function selectList(classBase) {
    const expressions = classBase.SELECT || {};

    return Object.keys(classBase.SCHEMA)
        .map(assertIdentifier)
        .map((column) => (expressions[column] ? `${expressions[column]} AS ${column}` : column))
        .join(", ");
}

function keyColumns(classBase) {
    if (classBase.KEY)
        return classBase.KEY.map(assertIdentifier);

    const id = Object.keys(classBase.SCHEMA).find((column) => classBase.SCHEMA[column] === "id");

    if (!id)
        throw new Error("classBase has no id column and no KEY");

    return [assertIdentifier(id)];
}

function writableColumns(classBase) {
    return Object.keys(classBase.SCHEMA).map(assertIdentifier).filter((column) => classBase.SCHEMA[column] !== "id");
}

class DB {
    constructor(options) {
        this._pool = new pg.Pool({
            ...options,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });

        this._pool.on("error", (err) => console.error(`[db] idle client error: ${err.message}`));
    }

    get pool() {
        return this._pool;
    }

    async connect({ attempts = 30, delayMs = 1000 } = {}) {
        let last;

        for (let i = 1; i <= attempts; i++) {
            try {
                await this._pool.query("SELECT 1");

                return { status: true, data: null };
            } catch (err) {
                last = err;
                if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
            }
        }
        throw { status: false, err: last };
    }

    query(text, params = []) {
        return this._pool.query(text, params);
    }

    async tx(work) {
        const client = await this._pool.connect();
        try {
            await client.query("BEGIN");
            const result = await work(client);
            await client.query("COMMIT");
            return result;
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    transaction(work) {
        return this.tx(work);
    }

    async requestDAO(table, classBase, extend = "", parameters = [], client = this._pool) {
        const result = await client.query(`SELECT ${selectList(classBase)} FROM ${assertIdentifier(table)}${extend ? " " + extend : ""};`, parameters);

        return { status: true, data: result.rows.map((row) => classBase.fromRow(row)) };
    }

    async getDAO(table, classBase, key, client = this._pool, { forUpdate = false } = {}) {
        const keys = keyColumns(classBase);
        const values = [].concat(key);

        if (values.length !== keys.length)
            throw new Error(`getDAO on ${table} needs ${keys.length} key value(s)`);

        const where = keys.map((column, index) => `${column} = $${index + 1}`).join(" AND ");
        const result = await client.query(`SELECT ${selectList(classBase)} FROM ${assertIdentifier(table)} WHERE ${where}${forUpdate ? " FOR UPDATE" : ""};`, values);

        return result.rows.length ? classBase.fromRow(result.rows[0]) : null;
    }

    async writeDAO(table, obj, classBase, client = this._pool) {
        const result = await this.writeManyDAO(table, [obj], classBase, client);
        return { status: true, data: result.data };
    }

    async writeManyDAO(table, objs, classBase, client = this._pool, { onConflict = "" } = {}) {
        if (objs.length === 0)
            return { status: true, data: [] };

        const writable = writableColumns(classBase);
        const perChunk = Math.max(1, Math.floor(30000 / writable.length));
        const stored = [];

        for (let offset = 0; offset < objs.length; offset += perChunk) {
            const chunk = objs.slice(offset, offset + perChunk);
            const params = [];
            const rows = chunk.map((obj) => {
                const values = obj.toObject();
                return `(${writable.map((column) => `$${params.push(values[column])}`).join(", ")})`;
            });
            const result = await client.query(
                `INSERT INTO ${assertIdentifier(table)} (${writable.join(", ")}) VALUES ${rows.join(", ")} ${onConflict} RETURNING ${selectList(classBase)};`,
                params
            );
            stored.push(...result.rows.map((row) => classBase.fromRow(row)));
        }
        return { status: true, data: stored };
    }

    async updateDAO(table, obj, classBase, client = this._pool) {
        const values = obj.toObject();
        const keys = keyColumns(classBase);
        const columns = Object.keys(classBase.SCHEMA).map(assertIdentifier).filter((column) => !keys.includes(column));
        const params = [];
        const set = columns.map((column) => `${column} = $${params.push(values[column])}`).join(", ");
        const where = keys.map((column) => `${column} = $${params.push(values[column])}`).join(" AND ");
        const result = await client.query(`UPDATE ${assertIdentifier(table)} SET ${set} WHERE ${where} RETURNING ${selectList(classBase)};`, params);

        return result.rows.length ? classBase.fromRow(result.rows[0]) : null;
    }

    async removeDAO(table, classBase, extend, parameters = [], client = this._pool) {
        if (!/^\s*WHERE\s/i.test(extend || ""))
            throw new Error("removeDAO needs a WHERE clause");

        const result = await client.query(`DELETE FROM ${assertIdentifier(table)} ${extend};`, parameters);

        return result.rowCount;
    }

    async countDAO(table, extend = "", parameters = [], client = this._pool) {
        const result = await client.query(`SELECT count(*)::int AS n FROM ${assertIdentifier(table)}${extend ? " " + extend : ""};`, parameters);

        return result.rows[0].n;
    }

    close() {
        return this._pool.end();
    }
}

module.exports = { DB, assertIdentifier };
