const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib, dom } = require('./helpers');

function setup() {
    const window = dom('<body><div id="c"></div></body>');
    const handlers = {}, calls = [];
    let script = () => ({ output: '', status: 0, cwd: '/' });
    const handle = {
        sessionId: 's1',
        on: (ev, fn) => { handlers[ev] = fn; },
        fetch: async (type) => type === 'prompt' ? { cwd: '/', user: 'alice' } : { matches: [] },
        update: async (type, args) => { calls.push([type, args]); return type === 'exec' ? script(args.line) : type === 'kill' ? { killed: true } : { cwd: (args && args.path) || '/' }; },
        close() {}
    };
    window.getSelection = () => ({ toString: () => '' });
    const g = { window, document: window.document, __apps: { getInstance: () => ({ open() {}, openPath() {} }) } };
    window.document.wsscon = { app: async () => handle };
    loadLib('apps/terminal/script/main.js', g);
    const view = window.document.createTerminalView(window.document.getElementById('c'), { handle });
    return { window, view, handle, handlers, calls, root: view.element, setScript: f => { script = f; }, out: () => view.element.querySelector('.tm-out').textContent };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const key = (t, k, extra = {}) => { const input = t.root.querySelector('.tm-input'); input.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); };
const submit = (t, text) => { t.root.querySelector('.tm-input').value = text; key(t, 'Enter'); };

test('a builtin answers at once and prints', async () => {
    const t = setup(); await tick();
    t.setScript(() => ({ output: 'hello\n', status: 0, cwd: '/music' }));
    submit(t, 'echo hello'); await tick();
    assert.match(t.out(), /hello/);
    assert.match(t.root.querySelector('.tm-prompt').textContent, /:\/music\$/, 'the prompt follows the new folder');
});

test('a program answers pending, shows a spinner, and prints when the exec_done event arrives', async () => {
    const t = setup(); await tick();
    t.setScript(() => ({ pending: 'j1', cwd: '/' }));
    submit(t, 'gcc a.c'); await tick();
    assert.ok(t.root.classList.contains('is-busy'));
    assert.ok(t.root.querySelector('.tm-spin'));
    t.handlers.exec_done({ job: 'j1', output: 'compiled\n', status: 0, cwd: '/documents', actions: [] }); await tick();
    assert.match(t.out(), /compiled/);
    assert.ok(!t.root.classList.contains('is-busy'));
    assert.equal(t.root.querySelector('.tm-spin'), null);
    assert.match(t.root.querySelector('.tm-prompt').textContent, /:\/documents\$/);
});

test('RACE: the result event may arrive before the reply that announced the job', async () => {
    const t = setup(); await tick();
    t.setScript(() => { t.handlers.exec_done({ job: 'fast', output: 'instant\n', status: 0, cwd: '/', actions: [] }); return { pending: 'fast', cwd: '/' }; });
    submit(t, 'python3 -c 1'); await tick(30);
    assert.match(t.out(), /instant/);
    assert.ok(!t.root.classList.contains('is-busy'), 'not stuck waiting for an event that already came');
});

test('lines typed while a program runs wait their turn, in order', async () => {
    const t = setup(); await tick();
    const order = [];
    t.setScript(line => { order.push(line); return line === 'slow' ? { pending: 'jj', cwd: '/' } : { output: line + '\n', status: 0, cwd: '/' }; });
    submit(t, 'slow'); submit(t, 'echo after'); await tick();
    assert.deepEqual(order, ['slow'], 'the second line has not been sent yet');
    t.handlers.exec_done({ job: 'jj', output: 'slow done\n', status: 0, cwd: '/', actions: [] }); await tick(30);
    assert.deepEqual(order, ['slow', 'echo after']);
    const text = t.out();
    assert.ok(text.indexOf('slow done') < text.lastIndexOf('after'), 'the second command output comes after the first');
});

test('Ctrl+C while a program runs stops it and drops the lines typed ahead', async () => {
    const t = setup(); await tick();
    const sent = [];
    t.setScript(line => { sent.push(line); return line === 'forever' ? { pending: 'jf', cwd: '/' } : { output: 'ran ' + line + '\n', status: 0, cwd: '/' }; });
    submit(t, 'forever'); submit(t, 'echo typed-ahead'); await tick();
    key(t, 'c', { ctrlKey: true }); await tick();
    assert.ok(t.calls.some(c => c[0] === 'kill'), 'the server was told to kill it');
    t.handlers.exec_done({ job: 'jf', output: '[interrupted]\n', status: 130, cwd: '/', actions: [] }); await tick(30);
    assert.deepEqual(sent, ['forever'], 'the typed-ahead line never ran');
    assert.match(t.out(), /\^C/);
    submit(t, 'echo again'); await tick();
    assert.match(t.out(), /ran echo again/, 'the shell is usable again');
});

test('Ctrl+C with nothing running only clears the input (no kill is sent)', async () => {
    const t = setup(); await tick();
    const input = t.root.querySelector('.tm-input'); input.value = 'half typed';
    key(t, 'c', { ctrlKey: true }); await tick();
    assert.equal(input.value, '');
    assert.ok(!t.calls.some(c => c[0] === 'kill'));
});

test('losing the connection frees a waiting prompt instead of hanging forever', async () => {
    const t = setup(); await tick();
    t.setScript(() => ({ pending: 'lost', cwd: '/' }));
    submit(t, 'python3 x.py'); await tick();
    t.handlers.restore(); await tick(30);
    assert.match(t.out(), /connection lost/);
    assert.ok(!t.root.classList.contains('is-busy'));
});

test('intents from a shortcut: start in a folder and run a command', async () => {
    const t = setup(); await tick();
    t.setScript(line => ({ output: 'ran ' + line + '\n', status: 0, cwd: '/documents' }));
    t.view.intent({ cwd: '/documents', run: 'ls' }); await tick(40);
    assert.ok(t.calls.some(c => c[0] === 'set_cwd' && c[1].path === '/documents'));
    assert.match(t.out(), /ran ls/);
});

test('program output is text: ANSI colours work, markup does not', async () => {
    const t = setup(); await tick();
    t.setScript(() => ({ output: '\x1b[31mred\x1b[0m <img src=x onerror=alert(1)>\n', status: 0, cwd: '/' }));
    submit(t, 'x'); await tick();
    assert.equal(t.root.querySelector('.tm-out img'), null);
    assert.ok(t.root.querySelector('.tm-out .a-31'));
});
