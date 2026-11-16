const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib, dom, box, pointer } = require('./helpers');

function setup(items, opts = {}) {
    const window = dom('<body><div id="s" style="position:relative"></div></body>');
    const surface = window.document.getElementById('s');
    box(surface, 100, 50, 400, 300);
    Object.defineProperty(surface, 'scrollWidth', { value: opts.scrollWidth || 400, configurable: true });
    Object.defineProperty(surface, 'scrollHeight', { value: opts.scrollHeight || 300, configurable: true });
    const els = items.map(([name, l, t, w, h]) => {
        const el = window.document.createElement('div');
        el.className = 'item'; el.dataset.name = name; surface.appendChild(el);
        return box(el, 100 + l, 50 + t, w, h);          // item rects given relative to the surface
    });
    const lib = loadLib('lib/lselect.js', { document: window.document, requestAnimationFrame: () => 0, cancelAnimationFrame() {} }).__select;
    const log = { changes: [], ends: [], starts: 0 };
    const band = lib.attach(Object.assign({
        surface, itemSelector: '.item',
        onChange: (hits, mode, final) => log.changes.push({ names: hits.map(h => h.dataset.name), mode, final }),
        onStart: () => { log.starts++; }, onEnd: moved => log.ends.push(moved)
    }, opts.attach || {}));
    return { window, surface, els, lib, band, log };
}
const ITEMS = [['a', 10, 10, 50, 50], ['b', 100, 10, 50, 50], ['c', 10, 100, 50, 50], ['d', 100, 100, 50, 50]];

test('dragging on empty space selects what the rectangle touches and reports the final set', () => {
    const t = setup(ITEMS);
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80);       // empty gap between the four
    pointer(t.window, 'pointermove', t.surface, 100 + 20, 50 + 20);       // up-left: touches a only
    assert.deepEqual(t.log.changes.at(-1).names, ['a']);
    pointer(t.window, 'pointermove', t.surface, 100 + 130, 50 + 130);     // down-right: touches d only
    assert.deepEqual(t.log.changes.at(-1).names, ['d']);
    pointer(t.window, 'pointermove', t.surface, 100 + 20, 50 + 20);
    pointer(t.window, 'pointerup', t.surface, 100 + 20, 50 + 20);
    const last = t.log.changes.at(-1);
    assert.equal(last.final, true);
    assert.deepEqual(last.names, ['a']);
    assert.deepEqual(t.log.ends, [true]);
    assert.equal(t.band.band.hidden, true, 'rectangle is gone afterwards');
});

test('a plain click (no movement) is not a drag: nothing selected, onEnd(false)', () => {
    const t = setup(ITEMS);
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80);
    pointer(t.window, 'pointermove', t.surface, 100 + 82, 50 + 81);       // 3px: under the threshold
    pointer(t.window, 'pointerup', t.surface, 100 + 82, 50 + 81);
    assert.deepEqual(t.log.changes, []);
    assert.deepEqual(t.log.ends, [false]);
});

test('pressing on an item does not start a rectangle (that is a click or an item drag)', () => {
    const t = setup(ITEMS);
    pointer(t.window, 'pointerdown', t.els[0], 100 + 20, 50 + 20);
    pointer(t.window, 'pointermove', t.surface, 100 + 200, 50 + 200);
    assert.equal(t.log.starts, 0);
    assert.deepEqual(t.log.changes, []);
});

test('only the primary button; touch and pen-less gestures are ignored', () => {
    const t = setup(ITEMS);
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80, { button: 2 });
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80, { pointerType: 'touch' });
    pointer(t.window, 'pointermove', t.surface, 100 + 200, 50 + 200);
    assert.equal(t.log.starts, 0);
});

test('modifier keys decide the mode', () => {
    for (const [mods, mode] of [[{}, 'replace'], [{ ctrlKey: true }, 'toggle'], [{ metaKey: true }, 'toggle'], [{ shiftKey: true }, 'add']]) {
        const t = setup(ITEMS);
        pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80, mods);
        pointer(t.window, 'pointermove', t.surface, 100 + 20, 50 + 20);
        assert.equal(t.log.changes.at(-1).mode, mode);
    }
});

test('the click that ends a drag is swallowed so the owner does not clear the new selection', () => {
    const t = setup(ITEMS);
    let clicks = 0;
    t.surface.addEventListener('click', () => clicks++);
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80);
    pointer(t.window, 'pointermove', t.surface, 100 + 20, 50 + 20);
    pointer(t.window, 'pointerup', t.surface, 100 + 20, 50 + 20);
    t.surface.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(clicks, 0, 'swallowed');
    t.surface.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(clicks, 1, 'but only that one');
});

test('a scrolled container: coordinates include the scroll offset', () => {
    const t = setup([['far', 10, 400, 50, 50], ['near', 10, 10, 50, 50]], { scrollHeight: 600 });
    Object.defineProperty(t.surface, 'scrollTop', { value: 350, writable: true, configurable: true });   // jsdom ignores scroll offsets: set it like a browser would
    t.els[0].getBoundingClientRect = () => ({ left: 110, top: 50 + 400 - 350, right: 160, bottom: 50 + 450 - 350, width: 50, height: 50 });
    t.els[1].getBoundingClientRect = () => ({ left: 110, top: 50 + 10 - 350, right: 160, bottom: 50 + 60 - 350, width: 50, height: 50 });
    pointer(t.window, 'pointerdown', t.surface, 100 + 300, 50 + 20);     // empty area at the top of the VISIBLE part
    pointer(t.window, 'pointermove', t.surface, 100 + 30, 50 + 150);     // drags down-left over the 'far' item
    assert.deepEqual(t.log.changes.at(-1).names, ['far']);
});

test('combine() implements replace / add / toggle on sets', () => {
    const { combine } = loadLib('lib/lselect.js').__select;
    const initial = new Set(['a', 'b']), hits = new Set(['b', 'c']);
    assert.deepEqual([...combine(initial, hits, 'replace')].sort(), ['b', 'c']);
    assert.deepEqual([...combine(initial, hits, 'add')].sort(), ['a', 'b', 'c']);
    assert.deepEqual([...combine(initial, hits, 'toggle')].sort(), ['a', 'c']);
});

test('rect geometry: any drag direction, touching edges do not select', () => {
    const { rectOf, intersects } = loadLib('lib/lselect.js').__select;
    assert.deepEqual(rectOf({ x: 50, y: 40 }, { x: 10, y: 90 }), { left: 10, top: 40, width: 40, height: 50 });
    const r = { left: 0, top: 0, width: 10, height: 10 };
    assert.equal(intersects(r, { left: 10, right: 20, top: 0, bottom: 10 }), false);
    assert.equal(intersects(r, { left: 9, right: 20, top: 0, bottom: 10 }), true);
});

test('Escape cancels the drag and reports it as not moved', () => {
    const t = setup(ITEMS);
    pointer(t.window, 'pointerdown', t.surface, 100 + 80, 50 + 80);
    pointer(t.window, 'pointermove', t.surface, 100 + 20, 50 + 20);
    t.window.document.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.deepEqual(t.log.ends, [false]);
    assert.equal(t.band.band.hidden, true);
});
