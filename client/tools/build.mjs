#!/usr/bin/env node

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[process.argv.indexOf("--out") + 1] || "dist");
const SKIP = new Set(["node_modules", "dist", "nginx", "build.mjs", "optimize.mjs", "package.json", "package-lock.json", "Dockerfile", ".dockerignore"]);

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
