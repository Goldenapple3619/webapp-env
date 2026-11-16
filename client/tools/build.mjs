#!/usr/bin/env node

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// `--out <dir>` (default: dist). NOTE: indexOf() is -1 when the flag is absent, and argv[-1 + 1] is argv[0] - the node binary.
// The first version of this line therefore resolved to the node executable and then deleted it. Parse explicitly, and refuse
// to wipe anything that does not look like an output folder of this build.
const flagAt = process.argv.indexOf("--out");
const flagValue = flagAt >= 0 ? process.argv[flagAt + 1] : undefined;
if (flagAt >= 0 && (!flagValue || flagValue.startsWith("-"))) { console.error("[build] --out needs a folder name"); process.exit(2); }
const out = path.resolve(flagValue || "dist");
const SKIP = new Set(["node_modules", "dist", "nginx", "tests", "tools", "build.mjs", "optimize.mjs", "package.json", "package-lock.json", "Dockerfile", ".dockerignore"]);   // tests/ and tools/ are development files: never ship them

const FINGERPRINT = /\.(js|css|json|svg|png|webp|jpg|ico)$|\/UI\/[^/]+\.html$/;
const COMPRESS = /\.(js|css|json|svg|html)$/;

async function walk(dir, base = "") {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!base && SKIP.has(entry.name)) continue;
        const rel = `${base}/${entry.name}`;
        if (entry.isDirectory()) files.push(...(await walk(path.join(dir, entry.name), rel)));
        else files.push(rel);
    }
    return files;
}

async function assertSafeToWipe(dir) {
    const protectedPaths = [path.parse(dir).root, SRC, process.execPath, process.env.HOME].filter(Boolean).map((x) => path.resolve(x));
    if (protectedPaths.includes(dir) || SRC.startsWith(dir + path.sep)) throw new Error(`refusing to wipe ${dir}`);
    let info;
    try { info = await stat(dir); } catch { return; }                       // does not exist yet: nothing to wipe
    if (!info.isDirectory()) throw new Error(`${dir} exists and is not a folder`);
    const names = await readdir(dir);
    if (names.length && !names.includes("v.js")) throw new Error(`${dir} is not empty and does not look like a previous build output (no v.js): refusing to delete it`);
}
try { await assertSafeToWipe(out); } catch (e) { console.error(`[build] ${e.message}`); process.exit(2); }
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const sizes = { before: 0, after: 0 };
const map = {};
const pages = [];

for (const rel of await walk(SRC)) {
    const from = path.join(SRC, rel);
    const to = path.join(out, rel);
    await mkdir(path.dirname(to), { recursive: true });

    let data = await readFile(from);
    sizes.before += data.length;

    if (rel.endsWith(".js")) data = Buffer.from((await transform(data.toString(), { loader: "js", minify: true, legalComments: "none", target: "es2019" })).code);
    else if (rel.endsWith(".css")) data = Buffer.from((await transform(data.toString(), { loader: "css", minify: true, legalComments: "none" })).code);
    else if (rel.endsWith(".json")) data = Buffer.from(JSON.stringify(JSON.parse(data.toString())));

    await writeFile(to, data);
    sizes.after += data.length;
    if (FINGERPRINT.test(rel)) map[rel] = createHash("sha1").update(data).digest("hex").slice(0, 8);
    if (rel.endsWith(".html") && !rel.includes("/UI/")) pages.push(rel);
}

const vjs = `window.__V=${JSON.stringify(map)};`;
await writeFile(path.join(out, "v.js"), vjs);
const vhash = createHash("sha1").update(vjs).digest("hex").slice(0, 8);

for (const rel of pages) {
    const file = path.join(out, rel);
    const dir = path.posix.dirname(rel);
    let html = await readFile(file, "utf8");
    html = html.replace(/(\s(?:src|href)=")([^"#?]+)(")/g, (m, a, url, b) => {
        if (/^(?:[a-z]+:|\/\/|data:)/i.test(url)) return m;
        const key = url.startsWith("/") ? url : path.posix.normalize(`${dir}/${url}`);
        return map[key] ? `${a}${url}?v=${map[key]}${b}` : m;
    });
    html = html.replace(/<script /, `<script defer src="/v.js?v=${vhash}"></script>\n    <script `);
    await writeFile(file, html);
}

let gz = 0;
for (const rel of await walk(out)) {
    if (!COMPRESS.test(rel)) continue;
    const buf = await readFile(path.join(out, rel));
    if (buf.length < 512) continue;
    const zipped = gzipSync(buf, { level: 9 });
    if (zipped.length < buf.length) { await writeFile(path.join(out, `${rel}.gz`), zipped); gz++; }
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`[build] ${Object.keys(map).length} fingerprinted files, ${pages.length} pages, ${gz} precompressed`);
console.log(`[build] ${kb(sizes.before)} -> ${kb(sizes.after)} after minification (before gzip) -> ${out}`);
