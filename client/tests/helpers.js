// Test helpers: load a browser lib (plain script defining a global) into node, optionally with a jsdom document.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function loadLib(file, globals = {}) {
    // Same realm as the tests (a vm context would give objects a foreign Object.prototype and break deepEqual).
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const names = [...code.matchAll(/^var (__\w+)\s*=/gm)].map(m => m[1]);
    const keys = Object.keys(globals);
    const fn = new Function(...keys, 'module', code + '\n;return {' + names.map(n => n + ':' + n).join(',') + '};');
    return fn(...keys.map(k => globals[k]), undefined);
}

function dom(html = '<body></body>') {
    const { JSDOM } = require(process.env.JSDOM_PATH || '/tmp/jt/node_modules/jsdom');
    const d = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' });
    return d.window;
}

/** gives an element a fake layout box (jsdom has none) */
function box(el, left, top, width, height) {
    el.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top });
    return el;
}

function pointer(window, type, target, x, y, extra = {}) {
    const ev = new window.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }, extra));
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    Object.defineProperty(ev, 'pointerType', { value: extra.pointerType || 'mouse' });
    target.dispatchEvent(ev);
    return ev;
}

module.exports = { loadLib, dom, box, pointer, ROOT };
