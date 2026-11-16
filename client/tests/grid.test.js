const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib } = require('./helpers');
const grid = loadLib('lib/lgrid.js').__grid;

test('saved cells are kept, new icons fill the first free cell column by column', () => {
    const r = grid.place(['a', 'b', 'c', 'd'], { a: { c: 1, r: 1 }, c: { c: 0, r: 0 } }, 3, 5);
    assert.deepEqual(r.cells.a, { c: 1, r: 1 });
    assert.deepEqual(r.cells.c, { c: 0, r: 0 });
    assert.deepEqual(r.cells.b, { c: 0, r: 1 });   // first free: column 0, row 1
    assert.deepEqual(r.cells.d, { c: 0, r: 2 });
    assert.deepEqual(r.fresh.sort(), ['b', 'd'], 'only never-seen icons need saving');
});

test('two icons can never share a cell, even if the saved layout says so', () => {
    const r = grid.place(['a', 'b'], { a: { c: 0, r: 0 }, b: { c: 0, r: 0 } }, 4, 4);
    assert.notDeepEqual(r.cells.a, r.cells.b);
    assert.deepEqual(r.fresh, [], 'b HAD a saved cell: relocating it for display must not overwrite the save');
});

test('a layout that does not fit a small screen is shown shifted but not marked for saving', () => {
    const saved = { far: { c: 9, r: 9 }, near: { c: 0, r: 1 } };
    const r = grid.place(['far', 'near'], saved, 3, 4);
    assert.deepEqual(r.cells.near, { c: 0, r: 1 });
    assert.ok(r.cells.far.r < 3 && r.cells.far.c < 4);
    assert.deepEqual(r.fresh, []);
});

test('arrange lines icons up column by column', () => {
    assert.deepEqual(grid.arrange(['a', 'b', 'c', 'd', 'e'], 2), { a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 1, r: 0 }, d: { c: 1, r: 1 }, e: { c: 2, r: 0 } });
});

test('pixel to cell honours the padding and never goes negative', () => {
    assert.deepEqual(grid.cellAt(12 + 98 * 2 + 5, 12 + 102 + 1, 98, 102, 12), { c: 2, r: 1 });
    assert.deepEqual(grid.cellAt(-50, -50, 98, 102, 12), { c: 0, r: 0 });
});

test('nearestFree searches outwards and stays inside the rows', () => {
    const taken = new Set(['1,1', '0,1', '1,0', '2,1', '1,2']);
    const got = grid.nearestFree(taken, { c: 1, r: 1 }, 3);
    assert.ok(!taken.has(grid.key(got.c, got.r)));
    assert.ok(got.r >= 0 && got.r < 3);
    assert.deepEqual(grid.nearestFree(new Set(), { c: 2, r: 99 }, 4), { c: 2, r: 3 }, 'clamped to the last row');
});

test('dragging several icons keeps their shape and dodges the ones that stay', () => {
    const moving = { a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 1, r: 0 } };
    const fixed = { x: { c: 4, r: 1 } };
    const out = grid.drop(moving, 'a', { c: 4, r: 0 }, fixed, 5);
    assert.deepEqual(out.a, { c: 4, r: 0 });
    assert.deepEqual(out.c, { c: 5, r: 0 });
    assert.notDeepEqual(out.b, fixed.x, 'b wanted (4,1) which x occupies: it takes a neighbour');
    const cells = Object.values(out).map(c => grid.key(c.c, c.r));
    assert.equal(new Set(cells).size, 3, 'no two moved icons collide');
});

test('dropping at negative offsets clamps at the edge instead of leaving the grid', () => {
    const out = grid.drop({ a: { c: 1, r: 1 }, b: { c: 2, r: 1 } }, 'b', { c: 0, r: 0 }, {}, 4);
    Object.values(out).forEach(c => { assert.ok(c.c >= 0 && c.r >= 0); });
    assert.equal(new Set(Object.values(out).map(c => grid.key(c.c, c.r))).size, 2);
});
