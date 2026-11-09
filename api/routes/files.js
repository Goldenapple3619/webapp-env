const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const archiver = require("archiver");

const { config } = require("../config/env.js");
const userfs = require("../src/services/userfs.js");
const realtime = require("../src/services/realtime.js");
const log = require("../src/lib/logger.js");
const { HttpError, badRequest, conflict, notFound } = require("../src/lib/errors.js");

const ACTIVE = new Set([".html", ".htm", ".xhtml", ".svg", ".xml", ".js", ".mjs", ".css"]);

const relPath = (req) => "/" + (req.params.path || []).join("/");

const activeZips = new Map();

async function download(req, res) {
    const { abs } = await userfs.resolveExisting(req.user.id, relPath(req));
    const stat = await fs.promises.stat(abs);
    const name = path.basename(abs) || "root";

    if (stat.isDirectory()) {
        if (req.query.zip === undefined)
            throw badRequest("is_directory");

        const running = activeZips.get(req.user.id) || 0;

        if (running >= config.maxZipsPerUser)
            throw new HttpError(429, "too_many_downloads");

        activeZips.set(req.user.id, running + 1);

        res.on("close", () => {
            const left = (activeZips.get(req.user.id) || 1) - 1;

            if (left > 0)
                activeZips.set(req.user.id, left);
            else
                activeZips.delete(req.user.id);
        });

        res.attachment(`${name}.zip`);
        res.type("zip");

        const archive = archiver("zip", { zlib: { level: 6 } });

        archive.on("error", (err) => res.destroy(err));
        res.on("close", () => archive.abort());
        archive.pipe(res);
        archive.directory(abs, false);

        return archive.finalize();
    }

    const ext = path.extname(abs).toLowerCase();
    const forceDownload = req.query.download !== undefined || ACTIVE.has(ext);

    res.setHeader("X-Content-Type-Options", "nosniff");

    if (ACTIVE.has(ext))
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");

    res.setHeader("Cache-Control", "private, no-cache");

    if (forceDownload)
        res.attachment(name);

    await new Promise((resolve, reject) =>
        res.sendFile(abs, { dotfiles: "allow", acceptRanges: true, cacheControl: false }, (err) => {
            if (err && !res.headersSent)
                return reject(err.status === 404 ? notFound() : err);

            resolve();
        })
    );
}

async function moveFile(from, to) {
    try {
        await fs.promises.rename(from, to);
    } catch (err) {
        if (err.code !== "EXDEV")
            throw err;

        await fs.promises.copyFile(from, to);
        await fs.promises.rm(from, { force: true });
    }
}

function limit(max) {
    let seen = 0;

    return new Transform({
        transform(chunk, _enc, cb) {
            seen += chunk.length;

            if (seen > max)
                return cb(new HttpError(413, "payload_too_large"));

            cb(null, chunk);
        },
    });
}

async function upload(req, res) {
    const rel = relPath(req);
    const { abs, relative, root } = userfs.resolve(req.user.id, rel);
    const name = path.basename(abs);

    if (abs === root || !name || name.length > 255)
        throw badRequest("invalid_path");

    const declared = Number(req.headers["content-length"] || 0);

    if (declared > config.maxUploadBytes)
        throw new HttpError(413, "payload_too_large");

    const parentRel = path.posix.dirname(relative);
    let parentAbs;

    if (req.query.parents === "1")
        parentAbs = await userfs.mkdirp(req.user.id, parentRel);
    else {
        const parent = await userfs.resolveExisting(req.user.id, parentRel).catch(() => null);

        if (!parent || !(await fs.promises.stat(parent.abs)).isDirectory())
            throw new HttpError(404, "parent_not_found");

        parentAbs = parent.abs;
    }

    const target = path.join(parentAbs, name);
    const existing = await fs.promises.stat(target).catch(() => null);

    if (existing?.isDirectory())
        throw conflict("is_directory");

    if (existing && req.query.overwrite !== "1")
        throw conflict("exists");

    await fs.promises.mkdir(userfs.userTmp(req.user.id), { recursive: true });

    const tmp = path.join(userfs.userTmp(req.user.id), `upload-${crypto.randomBytes(6).toString("hex")}.part`);

    try {
        await pipeline(req, limit(config.maxUploadBytes), fs.createWriteStream(tmp, { flags: "wx", mode: 0o644 }));
        await moveFile(tmp, target);
    } catch (err) {
        await fs.promises.rm(tmp, { force: true });

        if (err instanceof HttpError)
            throw err;

        if (err?.code === "ERR_STREAM_PREMATURE_CLOSE")
            return log.debug("upload aborted by the client", { id: req.id, path: relative });

        throw err;
    }

    const { size } = await fs.promises.stat(target);

    await realtime.fsChanged(req.user.id, "upload", { dirs: [parentRel], files: [relative] });
    res.status(201).json({ message: "upload_ok", code: 201, path: relative, size });
}

module.exports = {
    routes: [
        { method: "get", path: "/my{/*path}", protected: true, allowCookie: true, callback: download },
        { method: "put", path: "/my/*path", protected: true, callback: upload },
    ],
};
