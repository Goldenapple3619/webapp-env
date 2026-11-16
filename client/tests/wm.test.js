const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib, dom, box, pointer } = require('./helpers');

function setup(parentW = 1000, parentH = 700) {
    const window = dom('<body><div id="p"></div></body>');
    // jsdom has no layout: derive offset* from the inline style the manager writes, like a browser would
    const px = (el, p) => parseFloat(el.style[p]) || 0;
    const H = window.HTMLElement.prototype;
    Object.defineProperty(H, 'offsetLeft', { get() { return px(this, 'left'); }, configurable: true });
    Object.defineProperty(H, 'offsetTop', { get() { return px(this, 'top'); }, configurable: true });
    Object.defineProperty(H, 'offsetWidth', { get() { return this.style.width === '100%' ? this._pw : px(this, 'width'); }, configurable: true });
    Object.defineProperty(H, 'offsetHeight', { get() { return this.style.height === '100%' ? this._ph : px(this, 'height'); }, configurable: true });
    const parent = window.document.getElementById('p');
    parent._pw = parentW; parent._ph = parentH;
    Object.defineProperty(parent, 'clientWidth', { get() { return this._pw; } });
    Object.defineProperty(parent, 'clientHeight', { get() { return this._ph; } });
    box(parent, 0, 0, parentW, parentH);
    const origW = Object.getOwnPropertyDescriptor(H, 'offsetWidth').get;
    Object.defineProperty(H, 'offsetWidth', { get() { return this.style.width === '100%' ? parent._pw : px(this, 'width'); }, configurable: true });
    Object.defineProperty(H, 'offsetHeight', { get() { return this.style.height === '100%' ? parent._ph : px(this, 'height'); }, configurable: true });
    const wm = loadLib('lib/lde.js', { window, document: window.document, localStorage: window.localStorage, innerWidth: 1024, innerHeight: 768, ResizeObserver: undefined }).__window;
    return { window, parent, wm, resizeParent(w, h) { parent._pw = w; parent._ph = h; box(parent, 0, 0, w, h); window.dispatchEvent(new window.Event('resize')); } };
}

test('structure: frame clips, handles sit outside it, the app id is exposed for theming, min size is per window', () => {
    const t = setup();
    const w = t.wm.new('Files', [600, 400], t.parent, null, 0, { appId: 'explorer', minSize: [420, 300] });
    const el = w.element;
    assert.equal(el.dataset.app, 'explorer');
    assert.ok(el.querySelector(':scope > .win-frame > .win-header'));
    assert.ok(el.querySelector(':scope > .win-frame > .win-body'));
    assert.equal(el.querySelectorAll(':scope > .win-resize').length, 8, 'handles are children of .window, not of the clipping frame');
    assert.equal(el.style.minWidth, '420px');
    assert.equal(w.getBody().parentElement.className, 'win-frame');
});

test('a window can never be taller or wider than the desktop, nor smaller than its minimum', () => {
    const t = setup(500, 400);
    const big = t.wm.new('Big', [2000, 2000], t.parent, null, 0, { minSize: [300, 200] });
    assert.ok(big.element.offsetWidth <= 500 && big.element.offsetHeight <= 400);
    const tiny = t.wm.new('Tiny', [50, 50], t.parent, null, 0, { minSize: [300, 200] });
    assert.ok(tiny.element.offsetWidth >= 300 && tiny.element.offsetHeight >= 200);
});

test('shrinking the browser shrinks the windows too (they used to keep their size and overflow)', () => {
    const t = setup(1000, 700);
    const w = t.wm.new('W', [900, 600], t.parent, null, 0, { minSize: [260, 160] });
    t.resizeParent(500, 380);
    assert.ok(w.element.offsetWidth <= 500, 'width ' + w.element.offsetWidth);
    assert.ok(w.element.offsetHeight <= 380, 'height ' + w.element.offsetHeight);
    assert.ok(w.element.offsetLeft + w.element.offsetWidth <= 500, 'and entirely inside the desktop');
    t.resizeParent(200, 150);
    assert.equal(w.element.offsetWidth, 200 < 260 ? 200 : 260, 'never below what fits, never below the min when it fits');
});

test('maximize fills the area and restore brings the old rectangle back', () => {
    const t = setup(1000, 700);
    const w = t.wm.new('W', [600, 400], t.parent, null, 0, {});
    const before = { l: w.element.style.left, t: w.element.style.top, w: w.element.style.width, h: w.element.style.height };
    w.maximize();
    assert.ok(w.isMaximized() && w.element.classList.contains('is-maximized'));
    assert.equal(w.element.style.width, '100%');
    w.toggleMaximize();
    assert.deepEqual({ l: w.element.style.left, t: w.element.style.top, w: w.element.style.width, h: w.element.style.height }, before);
});

test('minimize hands the focus to the next window; closing does too', () => {
    const t = setup();
    const a = t.wm.new('A', [400, 300], t.parent, null, 0, {}), b = t.wm.new('B', [400, 300], t.parent, null, 0, {});
    assert.ok(b.isFocused() && !a.isFocused());
    b.minimize();
    assert.ok(a.isFocused() && b.isMinimized());
    b.focus();
    assert.ok(b.isFocused() && !b.isMinimized(), 'focusing restores');
    return b.close().then(() => assert.ok(a.isFocused()));
});

test('beforeClose can veto, and a forced close cannot be vetoed', async () => {
    const t = setup();
    const w = t.wm.new('A', [400, 300], t.parent, null, 0, {});
    w.beforeClose = () => false;
    assert.equal(await w.close(), false);
    assert.ok(t.parent.contains(w.element));
    assert.equal(await w.close(true), true);
    assert.ok(!t.parent.contains(w.element));
});

test('dragging a handle resizes but stops at the minimum size', () => {
    const t = setup(1000, 700);
    const w = t.wm.new('W', [600, 400], t.parent, null, 0, { minSize: [420, 300] });
    const se = w.element.querySelector('.win-resize[data-edge="se"]');
    const x0 = w.element.offsetLeft + 600, y0 = w.element.offsetTop + 400;
    pointer(t.window, 'pointerdown', se, x0, y0);
    pointer(t.window, 'pointermove', se, x0 - 500, y0 - 500);      // drag far up-left
    pointer(t.window, 'pointerup', se, x0 - 500, y0 - 500);
    assert.equal(w.element.offsetWidth, 420);
    assert.equal(w.element.offsetHeight, 300);
    const nw = w.element.querySelector('.win-resize[data-edge="nw"]');
    const right = w.element.offsetLeft + w.element.offsetWidth;
    pointer(t.window, 'pointerdown', nw, w.element.offsetLeft, w.element.offsetTop);
    pointer(t.window, 'pointermove', nw, w.element.offsetLeft + 900, w.element.offsetTop + 900);   // shrink from the top-left
    pointer(t.window, 'pointerup', nw, 0, 0);
    assert.equal(w.element.offsetWidth, 420, 'cannot shrink below the minimum');
    assert.equal(w.element.offsetLeft + w.element.offsetWidth, right, 'the opposite edge stays where it was');
});

test('the size an app was given is remembered for next time (and an explicit size wins)', () => {
    const t = setup(1200, 800);
    const a = t.wm.new('A', [600, 400], t.parent, null, 0, { appId: 'code' });
    const se = a.element.querySelector('.win-resize[data-edge="se"]');
    const x = a.element.offsetLeft + 600, y = a.element.offsetTop + 400;
    pointer(t.window, 'pointerdown', se, x, y);
    pointer(t.window, 'pointermove', se, x + 100, y + 50);
    pointer(t.window, 'pointerup', se, x + 100, y + 50);
    const b = t.wm.new('B', [600, 400], t.parent, null, 0, { appId: 'code' });
    assert.equal(b.element.offsetWidth, 700);
    assert.equal(b.element.offsetHeight, 450);
    const c = t.wm.new('C', [500, 300], t.parent, null, 0, { appId: 'code', explicitSize: true });
    assert.equal(c.element.offsetWidth, 500);
});

test('setSize (used by shortcuts) is clamped to the desktop and the minimum', () => {
    const t = setup(800, 600);
    const w = t.wm.new('W', [500, 400], t.parent, null, 0, { minSize: [300, 200] });
    w.setSize(5000, 5000);
    assert.ok(w.element.offsetWidth <= 800 && w.element.offsetHeight <= 600);
    w.setSize(10, 10);
    assert.equal(w.element.offsetWidth, 300);
});

test('titles are text, never markup', () => {
    const t = setup();
    const w = t.wm.new('<img src=x onerror=alert(1)>', [400, 300], t.parent, null, 0, {});
    assert.equal(w.element.querySelector('img'), null);
    w.setTitle('<b>x</b>');
    assert.equal(w.element.querySelector('.win-title b'), null);
});

test('maximized-on-open (a shortcut can ask for it)', () => {
    const t = setup();
    const w = t.wm.new('W', [400, 300], t.parent, null, 0, { maximized: true });
    assert.ok(w.isMaximized());
});
