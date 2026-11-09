const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../../config/env.js");
const { HttpError } = require("../lib/errors.js");

const SKELETON = ["root", "root/documents", "root/desktop", "root/music", "root/videos", "root/downloads", "root/pictures", "appdata", "tmp"];

const systemUsersDir = () => path.join(config.systemRoot, "users");
const userDir = (userId) => path.join(systemUsersDir(), String(Number(userId)));
const userRoot = (userId) => path.join(userDir(userId), "root");
const userTmp = (userId) => path.join(userDir(userId), "tmp");

function ensureUser(userId) {
    for (const rel of SKELETON)
        fs.mkdirSync(path.join(userDir(userId), rel), { recursive: true });
}

function resolve(userId, relative) {
    const root = userRoot(userId);
    const text = String(relative ?? "/");

    if (text.includes("\0"))
        throw new HttpError(400, "invalid_path");

    const clean = path.posix.normalize("/" + text.replaceAll("\\", "/"));
    const abs = path.join(root, clean);

    if (abs !== root && !abs.startsWith(root + path.sep))
        throw new HttpError(404, "not_found");

    return { root, abs, relative: clean };
}

async function resolveExisting(userId, relative) {
    const target = resolve(userId, relative);
    try {
        const [real, realRoot] = await Promise.all([fs.promises.realpath(target.abs), fs.promises.realpath(target.root)]);

        if (real !== realRoot && !real.startsWith(realRoot + path.sep))
            throw new Error("escape");

        return { ...target, abs: real };
    } catch {
        throw new HttpError(404, "not_found");
    }
}

async function mkdirp(userId, relative) {
    const { relative: clean } = resolve(userId, relative);
    let current = await resolveExisting(userId, "/");

    for (const segment of clean.split("/").filter(Boolean)) {
        const next = path.posix.join(current.relative, segment);

        try {
            current = await resolveExisting(userId, next);

            if (!(await fs.promises.stat(current.abs)).isDirectory())
                throw new HttpError(409, "not_a_directory");
        } catch (err) {
            if (!(err instanceof HttpError) || err.status !== 404)
                throw err;

            await fs.promises.mkdir(path.join(current.abs, segment), { mode: 0o755 }).catch((e) => {
                if (e.code !== "EEXIST") throw e;
            });

            current = await resolveExisting(userId, next);
        }
    }

    return current.abs;
}

module.exports = { ensureUser, resolve, resolveExisting, mkdirp, userRoot, userTmp, userDir, systemUsersDir, SKELETON };
