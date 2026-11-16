const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ROOT } = require('./helpers');

function walk(dir, out = []) {
    for (const n of fs.readdirSync(dir)) {
        if (n === 'node_modules' || n === 'tests' || n === 'dist' || n.startsWith('.')) continue;
        const p = path.join(dir, n);
        fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p);
    }
    return out;
}
const files = walk(ROOT);
const sprite = fs.readFileSync(path.join(ROOT, 'assets/images/icons.svg'), 'utf8');
const ICONS = new Set([...sprite.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)].map(m => m[1]));

test('the icon sprite is well formed and every icon the code names exists in it', () => {
    assert.ok(ICONS.size > 50);
    const missing = [];
    for (const f of files.filter(f => /\.(js|html)$/.test(f))) {
        const text = fs.readFileSync(f, 'utf8');
        // icon('name'), icon("name"), ui.icon('name'), icons.svg#name, icon: 'name', 'icon-name' in menu items
        const names = new Set();
        for (const m of text.matchAll(/\bicon\(\s*['"]([a-z0-9-]+)['"]/g)) names.add(m[1]);
        for (const m of text.matchAll(/icons\.svg#([a-z0-9-]+)/g)) names.add(m[1]);
        for (const m of text.matchAll(/\bicon:\s*'([a-z][a-z0-9-]+)'/g)) names.add(m[1]);
        for (const n of names) if (!ICONS.has(n)) missing.push(path.relative(ROOT, f) + ': ' + n);
    }
    assert.deepEqual(missing, []);
});

test('registry icons exist', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/registry.json'), 'utf8')).apps;
    for (const a of reg) assert.ok(ICONS.has(a.icon), a.id + ' → ' + a.icon);
});

test('every <script src> and <link href> of a page exists', () => {
    for (const f of files.filter(f => f.endsWith('.html') && !f.includes('/UI/'))) {
        const text = fs.readFileSync(f, 'utf8');
        for (const m of text.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css|svg|png|json))"/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), path.relative(ROOT, f) + ' → ' + m[1]);
    }
});

test('every script / style / UI a manifest lists exists', () => {
    for (const f of files.filter(f => f.endsWith('index.json') && !f.includes('registry'))) {
        const dir = path.dirname(f), m = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const key of ['styles', 'scripts', 'UIs']) for (const rel of m[key] || []) {
            const p = rel.startsWith('/') ? path.join(ROOT, rel) : path.join(dir, rel);
            assert.ok(fs.existsSync(p), path.relative(ROOT, f) + ' ' + key + ' → ' + rel);
        }
    }
});

test('no page is missing a library that another script of it relies on', () => {
    // a lib that calls another global must be loaded in every page that loads it
    const needs = { 'lprops.js': ['lui.js'], 'lpicker.js': ['lui.js'], 'lshortcut.js': ['lapps.js', 'lprops.js', 'lui.js'], 'lselect.js': [], 'lgrid.js': [] };
    for (const f of files.filter(f => /index\.html$/.test(f) && !f.includes('/UI/'))) {
        const text = fs.readFileSync(f, 'utf8'), loaded = [...text.matchAll(/\/lib\/([a-z]+\.js)/g)].map(m => m[1]);
        for (const lib of loaded) for (const dep of needs[lib] || []) assert.ok(loaded.includes(dep), path.relative(ROOT, f) + ': ' + lib + ' needs ' + dep);
        assert.deepEqual(loaded.filter((l, i) => loaded.indexOf(l) !== i), [], 'a library is loaded twice in ' + f);
    }
});

test('no browser-storage-free rule is broken: user content is never put in innerHTML un-escaped in the new libraries', () => {
    // a coarse guard: every innerHTML assignment in the new code uses a literal, __ui.icon(), esc(), or a static template
    for (const f of ['lib/lprops.js', 'lib/lpicker.js', 'lib/lshortcut.js', 'desktop/script/icons.js', 'desktop/script/appearance.js']) {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const line of text.split('\n')) {
            if (!/\.innerHTML\s*[+]?=/.test(line)) continue;
            const rhs = line.slice(line.indexOf('=') + 1);
            const dynamic = [...rhs.matchAll(/\+\s*([A-Za-z_][\w.]*)(?!\()\s*(?=[+;])/g)].map(m => m[1]).filter(n => !/^(esc|ui\.esc|__ui\.esc)$/.test(n));
            assert.deepEqual(dynamic.filter(n => !/\.swatch$|^c$/.test(n)), [], f + ': ' + line.trim().slice(0, 120));
        }
    }
});
