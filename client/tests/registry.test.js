const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ROOT } = require('./helpers');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/registry.json'), 'utf8')).apps;
const dirs = { explorer: 'explorer', music: 'musicPlayer', code: 'code', terminal: 'terminal' };

test('every theme default declared in the registry is exactly what the app stylesheet says (one look, two places: keep them equal)', () => {
    for (const app of reg.filter(a => a.theme)) {
        const css = fs.readFileSync(path.join(ROOT, 'apps', dirs[app.id], 'style/main.css'), 'utf8');
        for (const v of app.theme.vars) {
            assert.ok(css.includes(v.key + ':') || css.includes(v.key + ' '), `${app.id}: ${v.key} is not defined/used in its stylesheet`);
            if (v.default !== undefined) {
                const m = new RegExp(v.key + ':\\s*([^;}]+)', 'i').exec(css);
                assert.ok(m, `${app.id}: no declaration of ${v.key}`);
                const found = m[1].trim().toLowerCase();
                assert.equal(found, String(v.default).toLowerCase() + (v.unit || ''), `${app.id} ${v.key}`);
            }
            if (v.inherit) assert.match(css, new RegExp(v.key + ':\\s*var\\(' + v.inherit.replace(/-/g, '\\-') + '\\)'), `${app.id} ${v.key} should default to var(${v.inherit})`);
        }
    }
});

test('theme roots exist as a selector in the app stylesheet', () => {
    for (const app of reg.filter(a => a.theme)) {
        const css = fs.readFileSync(path.join(ROOT, 'apps', dirs[app.id], 'style/main.css'), 'utf8');
        assert.ok(css.includes(app.theme.root + ' {') || css.includes(app.theme.root + ','), `${app.id}: root ${app.theme.root}`);
    }
});

test('every real app declares a minimum size smaller than its default size, and no two apps share an id', () => {
    const ids = new Set();
    for (const app of reg) {
        assert.ok(!ids.has(app.id)); ids.add(app.id);
        assert.ok(Array.isArray(app.minSize) && app.minSize.length === 2, app.id + ' minSize');
        assert.ok(app.minSize[0] <= app.size[0] && app.minSize[1] <= app.size[1], app.id + ': min must fit inside the default size');
    }
});

test('typed theme variables have ranges that contain their default', () => {
    for (const app of reg.filter(a => a.theme)) for (const v of app.theme.vars) {
        assert.ok(['color', 'number', 'select'].includes(v.type));
        if (v.type === 'number') assert.ok(v.min <= v.default && v.default <= v.max, `${app.id} ${v.key}`);
        if (v.type === 'color') assert.ok(v.default || v.inherit, `${app.id} ${v.key} needs a default or an inherited token`);
    }
});
