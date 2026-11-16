const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib, dom } = require('./helpers');

function setup({ withWindowManager = false } = {}) {
    const window = dom('<body><div id="wm"></div></body>');
    window.fetch = async () => ({ text: async () => '<symbol id="music"/><symbol id="code"/><symbol id="folder"/>' });
    const g = { window, document: window.document, fetch: window.fetch, localStorage: window.localStorage, innerWidth: 1024, innerHeight: 768, auth: { fileUrl: p => '/api/my' + p } };
    Object.assign(g, loadLib('lib/lui.js', g));
    if (withWindowManager) {
        const wm = window.document.getElementById('wm');
        Object.defineProperty(wm, 'clientWidth', { value: 1000 }); Object.defineProperty(wm, 'clientHeight', { value: 700 });
        Object.assign(g, loadLib('lib/lde.js', g));
        window.__window = g.__window;      // a top-level `var` is a window property in a browser
    }
    Object.assign(g, loadLib('lib/lprops.js', g));
    return { window, document: window.document, props: g.__props, ui: g.__ui, g };
}
const tick = () => new Promise(r => setTimeout(r, 5));
const type = (window, el, value) => { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };

const SPEC = () => ({
    title: 'Music', subtitle: '/desktop/Music.shc', icon: 'music',
    tabs: [
        { id: 'general', label: 'General', fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
            { key: 'extra', label: 'Extra', type: 'text', showIf: v => v.kind === 'b' },
            { key: 'size', label: 'Size', type: 'number', validate: v => v != null && v < 0 ? 'Must be positive.' : '' },
            { key: 'on', label: 'On', type: 'checkbox', text: 'Enabled' },
            { type: 'info', label: 'Path', value: '/desktop/Music.shc' }] },
        { id: 'args', label: 'Arguments', fields: [
            { key: 'args', label: 'Args', type: 'rows', columns: [{ key: 'name', label: 'Name' }, { key: 'value', label: 'Value' }] }] }],
    values: { name: 'Music', kind: 'a', extra: '', size: 5, on: true, args: [{ name: 'play', value: '/m/a.mp3' }] }
});

for (const mode of [true, false]) {
    test(`renders the form from a description (${mode ? 'in a window' : 'as a dialog'})`, async () => {
        const t = setup({ withWindowManager: mode });
        const api = t.props.open(SPEC());
        await tick();
        const q = s => t.document.querySelector(s);
        assert.equal(q('.pr-title').textContent, 'Music');
        assert.equal(q('.pr-sub').textContent, '/desktop/Music.shc');
        assert.equal(t.document.querySelectorAll('.pr-tab').length, 2);
        assert.equal(q('#' + q('.pr-field input[type=text]').id).value, 'Music');
        assert.deepEqual(api.getValues().args, [{ name: 'play', value: '/m/a.mp3' }]);
        assert.equal(api.getValues().on, true);
        assert.equal(api.getValues().size, 5);
        if (mode) assert.ok(t.document.querySelector('#wm .window .pr'), 'inside a desktop window'); else assert.ok(t.document.querySelector('.ui-overlay .pr'), 'inside a modal dialog');
    });
}

test('showIf hides and shows fields as other values change', async () => {
    const t = setup();
    t.props.open(SPEC());
    await tick();
    const extra = [...t.document.querySelectorAll('.pr-field')].find(f => f.textContent.includes('Extra'));
    assert.equal(extra.hidden, true);
    const sel = t.document.querySelector('select');
    sel.value = 'b'; sel.dispatchEvent(new t.window.Event('change', { bubbles: true }));
    assert.equal(extra.hidden, false);
});

test('validation blocks Apply, shows the message under the field, and a hidden field is not validated', async () => {
    const t = setup();
    let applied = 0;
    const spec = SPEC(); spec.onApply = () => { applied++; };
    t.props.open(spec);
    await tick();
    const name = t.document.querySelector('.pr-field input[type=text]');
    type(t.window, name, '');
    const ok = [...t.document.querySelectorAll('.pr-foot .btn')].find(b => b.textContent === 'OK');
    ok.click(); await tick();
    assert.equal(applied, 0);
    assert.match(t.document.querySelector('.pr-field.has-error .pr-error').textContent, /Required/);
    type(t.window, name, 'Fine');
    const size = [...t.document.querySelectorAll('input[type=number]')][0];
    type(t.window, size, '-3');
    ok.click(); await tick();
    assert.equal(applied, 0);
    assert.match(t.document.body.textContent, /Must be positive/);
    type(t.window, size, '3');
    ok.click(); await tick();
    assert.equal(applied, 1);
});

test('Apply sends the edited values; a server error becomes a banner, or a field message when it names the field', async () => {
    const t = setup();
    const calls = [];
    const spec = SPEC();
    spec.onApply = (values) => { calls.push(values); if (calls.length === 1) return Promise.reject({ code: 'invalid_shortcut', details: { detail: 'the server says no' } }); if (calls.length === 2) return Promise.reject({ field: 'name', code: 'exists' }); };
    t.props.open(spec);
    await tick();
    type(t.window, t.document.querySelector('.pr-field input[type=text]'), 'Renamed');
    const apply = [...t.document.querySelectorAll('.pr-foot .btn')].find(b => b.textContent === 'Apply');
    assert.equal(apply.disabled, false, 'enabled once something changed');
    apply.click(); await tick();
    assert.equal(calls[0].name, 'Renamed');
    assert.equal(t.document.querySelector('.pr-banner').textContent, 'the server says no');
    apply.click(); await tick();
    assert.match(t.document.querySelector('.pr-field.has-error .pr-error').textContent, /already exists/);
    apply.click(); await tick();
    assert.equal(t.document.querySelector('.pr-banner').textContent, '');
    assert.equal(apply.disabled, true, 'clean again after a successful apply');
});

test('the rows editor adds, edits and removes rows', async () => {
    const t = setup();
    const api = t.props.open(SPEC());
    await tick();
    t.document.querySelector('.pr-tab[data-tab="args"]').click();
    const add = [...t.document.querySelectorAll('.pr-rows .btn')].find(b => b.textContent === 'Add');
    add.click(); add.click();
    const rows = t.document.querySelectorAll('.pr-rows .pr-row:not(.pr-row-head)');
    assert.equal(rows.length, 3);
    type(t.window, rows[1].querySelector('[data-key=name]'), 'queue'); type(t.window, rows[1].querySelector('[data-key=value]'), '/m/b.mp3');
    rows[0].querySelector('button').click();
    assert.deepEqual(api.getValues().args, [{ name: 'queue', value: '/m/b.mp3' }, { name: '', value: '' }]);
});

test('closing with unsaved edits asks first; discarding closes; a window honours the same veto', async () => {
    const t = setup({ withWindowManager: true });
    const api = t.props.open(SPEC());
    await tick();
    type(t.window, t.document.querySelector('.pr-field input[type=text]'), 'changed');
    const closing = api.close();
    await tick();
    assert.ok(t.document.querySelector('.ui-dialog'), 'a confirmation appeared');
    [...t.document.querySelectorAll('.ui-dialog .btn')].find(b => b.textContent === 'Keep editing').click();
    assert.equal(await closing, false);
    assert.ok(t.document.querySelector('#wm .window'), 'still open');
    const again = api.close();
    await tick();
    [...t.document.querySelectorAll('.ui-dialog .btn')].find(b => b.textContent === 'Discard').click();
    await again; await tick();
    assert.equal(t.document.querySelector('#wm .window'), null);
});

test('the same id focuses the existing window instead of opening a second', async () => {
    const t = setup({ withWindowManager: true });
    const a = t.props.open({ ...SPEC(), id: 'x' }), b = t.props.open({ ...SPEC(), id: 'x' });
    assert.equal(a, b);
    assert.equal(t.document.querySelectorAll('#wm .window').length, 1);
});

test('read-only mode (file info) has no inputs to edit and just a Close button', async () => {
    const t = setup({ withWindowManager: true });
    t.props.openFileInfo({ name: 'a.txt', path: '/documents/a.txt', type: 'file', ext: 'txt', size: 2048, modification_date: 1700000000 });
    await tick();
    const text = t.document.querySelector('.pr').textContent;
    assert.match(text, /a\.txt/); assert.match(text, /\/documents/); assert.match(text, /TXT file/); assert.match(text, /2\.0 KB/);
    assert.deepEqual([...t.document.querySelectorAll('.pr-foot .btn')].map(b => b.textContent), ['Close']);
});

test('values are text: markup in titles or values is never interpreted', async () => {
    const t = setup();
    t.props.open({ title: '<img src=x onerror=1>', subtitle: '<b>x</b>', tabs: [{ id: 'a', label: '<i>t</i>', fields: [{ type: 'info', label: '<u>l</u>', value: '<script>1</script>' }] }] });
    await tick();
    assert.equal(t.document.querySelector('.pr img, .pr b, .pr i, .pr u, .pr script'), null);
});
