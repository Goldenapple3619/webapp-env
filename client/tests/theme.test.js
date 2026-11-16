const test = require('node:test'), assert = require('node:assert/strict');
const { loadLib } = require('./helpers');
const T = loadLib('lib/ltheme.js').__theme;
const REG = [
    { id: 'terminal', theme: { root: '.tm', vars: [
        { key: '--tm-bg', type: 'color' }, { key: '--tm-font-size', type: 'number', unit: 'px', min: 10, max: 24 },
        { key: '--tm-cursor', type: 'select', options: [{ value: 'block' }, { value: 'bar' }] }] } },
    { id: 'music', theme: { root: '.mp', vars: [{ key: '--mp-accent', type: 'color' }] } },
    { id: 'viewer' }];

test('an empty appearance reproduces the ORIGINAL look exactly (the current theme is the default)', () => {
    const r = T.resolve({}, REG, null);
    const expected = { '--bg-main': '#dcd4f0', '--bg-secondary': '#e0c6e7', '--bg-terciary': '#c1b1e6', '--bg-quaduary': '#bba1f0',
        '--border-secondary': '#b397ed', '--ink': '#2c1f4d', '--accent': '#fc82b8', '--accent-2': '#fc9dc9', '--accent-edge': '#e2639d',
        '--accent-ink': '#6e1b45', '--on-accent': '#3b0d24', '--win-body-background': '#fae3ed',
        '--win-frame': '#fc82b8', '--win-header-background': '#fc9dc9', '--win-header-background-inactive': '#f3bdd6', '--win-header-color': '#ffffff',
        '--win-border-width': '4px', '--win-radius': '8px', '--taskbar-height': '42px', '--taskbar-bg': '#e0c6e7', '--taskbar-ink': '#2c1f4d' };
    for (const [k, v] of Object.entries(expected)) assert.equal(r.vars[k], v, k);
    assert.equal(r.vars['--selection'], 'rgba(252, 130, 184, 0.28)', 'the same translucent pink as the stylesheet had');
    assert.equal(r.vars['--win-shadow'], '0 12px 28px -8px rgba(44, 31, 77, .45), 0 2px 6px rgba(44, 31, 77, .25)');
    assert.equal(r.attrs['data-taskbar'], 'bottom');
    assert.equal(r.attrs['data-win-buttons'], 'square');
    assert.ok(r.unset.includes('--desktop-image'), 'default desktop = the gradient from the stylesheet');
    assert.deepEqual(r.appRules, []);
});

test('presets differ and all define the same tokens', () => {
    const keys = Object.keys(T.PRESETS.candy.tokens).sort();
    for (const id of T.PRESET_ORDER) assert.deepEqual(Object.keys(T.PRESETS[id].tokens).sort(), keys, id);
    assert.notEqual(T.resolve({ preset: 'midnight' }).vars['--bg-main'], T.resolve({}).vars['--bg-main']);
    assert.equal(T.resolve({ preset: 'does-not-exist' }).vars['--bg-main'], '#dcd4f0', 'unknown preset -> default');
});

test('choosing an accent re-derives the family and the window chrome follows', () => {
    const r = T.resolve({ colors: { '--accent': '#2f80ed' } });
    assert.equal(r.vars['--accent'], '#2f80ed');
    for (const k of ['--accent-2', '--accent-edge', '--accent-ink', '--on-accent']) assert.match(r.vars[k], /^#[0-9a-f]{6}$/, k);
    assert.notEqual(r.vars['--accent-2'], r.vars['--accent']);
    assert.equal(r.vars['--win-frame'], '#2f80ed');
    assert.ok(T.util.contrast(r.vars['--on-accent'], r.vars['--accent']) >= 4.5, 'text on the accent stays readable');
    const explicit = T.resolve({ colors: { '--accent': '#2f80ed', '--accent-edge': '#000000' } });
    assert.equal(explicit.vars['--accent-edge'], '#000000', 'an explicit override beats the derived value');
});

test('text on any accent is readable', () => {
    for (const c of ['#fc82b8', '#ffff00', '#000000', '#ffffff', '#2fb67c', '#1a1aff', '#ff0000', '#808080'])
        assert.ok(T.util.contrast(T.util.inkOn(c), c) >= 4.4, c);
});

test('hostile values are ignored, never applied', () => {
    const evil = { colors: { '--accent': 'red; background:url(//evil)', '--x': '#fff', 'bad name': '#fff', '--ok': 'url(javascript:1)' },
        windows: { frame: '"><script>', radius: 'DROP', shadow: '1px 1px 1px red', titleFont: 'Comic; evil', header: 5 },
        taskbar: { bg: 'expression(1)', height: 9999, position: 'left; x' }, desktop: { mode: 'color', color: 'rgb(0,0,0)' } };
    const r = T.resolve(evil, REG, null);
    assert.equal(r.vars['--accent'], '#fc82b8');
    assert.equal(r.vars['--win-frame'], '#fc82b8');
    assert.equal(r.vars['--ok'], '#2c7d5f');
    assert.equal(r.vars['--x'], '#ffffff', 'a valid colour passes (and is normalised to 6 digits): it is only a colour');
    assert.equal(r.vars['bad name'], undefined);
    assert.equal(r.vars['--win-radius'], '0px', 'garbage number is clamped, not echoed');
    assert.equal(r.vars['--win-header-font-family'], 'var(--font-pixel)');
    assert.equal(r.vars['--taskbar-height'], '72px');
    assert.equal(r.attrs['data-taskbar'], 'bottom');
    for (const v of Object.values(r.vars)) assert.doesNotMatch(String(v), /script|evil|expression|javascript/);
    assert.ok(r.unset.includes('--desktop-image'), 'rgb() is not an accepted colour: falls back to the default desktop');
});

test('desktop background: colour, and image with a url that cannot break out of url("...")', () => {
    const c = T.resolve({ desktop: { mode: 'color', color: '#112233', dim: 30 } });
    assert.equal(c.vars['--desktop-color'], '#112233');
    assert.equal(c.vars['--desktop-image'], 'none');
    assert.equal(c.vars['--desktop-dim'], '0.3');
    const i = T.resolve({ desktop: { mode: 'image', image: '/pictures/a "b" (1).png', fit: 'tile' } }, [], p => '/api/my' + p + '?x=")}body{background:red');
    const v = i.vars['--desktop-image'];
    assert.match(v, /^url\("[^"]*"\)$/, 'exactly one quoted url, nothing after it');
    assert.doesNotMatch(v.slice(5, -2), /["()\\\s]/);
    assert.equal(i.vars['--desktop-repeat'], 'repeat');
    assert.equal(T.resolve({ desktop: { mode: 'image', image: '/x.png', fit: 'cover' } }, [], p => p).vars['--desktop-size'], 'cover');
    assert.ok(T.resolve({ desktop: { mode: 'image', image: 'relative.png' } }, [], p => p).unset.includes('--desktop-image'), 'only absolute user paths');
    assert.ok(T.resolve({ desktop: { mode: 'image', image: '/x.png' } }, [], null).unset.includes('--desktop-image'), 'no url builder: no image');
});

test('taskbar: opacity makes the colour translucent, position and flags become attributes', () => {
    const r = T.resolve({ taskbar: { bg: '#102030', opacity: 60, position: 'top', labels: false, clock: false, height: 50 } });
    assert.match(r.vars['--taskbar-bg'], /^#102030[0-9a-f]{2}$/);
    assert.equal(r.vars['--taskbar-backdrop'], 'blur(8px)');
    assert.ok(T.util.contrast(r.vars['--taskbar-ink'], '#102030') > 4.5, 'ink follows a custom taskbar colour');
    assert.equal(r.attrs['data-taskbar'], 'top');
    assert.equal(r.attrs['data-taskbar-labels'], 'off');
    assert.equal(r.attrs['data-taskbar-clock'], 'off');
    assert.equal(r.attrs['data-taskbar-date'], 'on');
    assert.equal(r.vars['--taskbar-height'], '50px');
});

test('windows: custom header derives the inactive colour and a readable title colour', () => {
    const r = T.resolve({ windows: { header: '#203040', radius: 14, border: 2, shadow: 'none', titleFont: 'ui', buttons: 'round', animations: false } });
    assert.equal(r.vars['--win-header-background'], '#203040');
    assert.ok(T.util.contrast(r.vars['--win-header-color'], '#203040') >= 3);
    assert.notEqual(r.vars['--win-header-background-inactive'], '#f3bdd6');
    assert.equal(r.vars['--win-radius'], '14px');
    assert.equal(r.vars['--win-shadow'], 'none');
    assert.equal(r.vars['--win-header-font-family'], 'var(--font-ui)');
    assert.equal(r.attrs['data-win-buttons'], 'round');
    assert.equal(r.attrs['data-win-anim'], 'off');
});

test('per-application themes: only declared variables, typed and clamped, scoped by the registry selector', () => {
    const r = T.resolve({ apps: {
        terminal: { vars: { '--tm-bg': '#101010', '--tm-font-size': 99, '--tm-cursor': 'bar', '--not-declared': '#ffffff' }, frame: '#00ff00', header: '#003300' },
        music: { vars: { '--mp-accent': 'nope' } }, ghost: { vars: { '--x': '#fff' } }, viewer: { vars: { '--y': '#fff' } } } }, REG);
    assert.equal(r.appRules.length, 1, 'music has an invalid value, ghost is unknown, viewer declares nothing');
    assert.equal(r.appRules[0].selector, 'html body .tm');
    assert.deepEqual(r.appRules[0].vars, { '--tm-bg': '#101010', '--tm-font-size': '24px', '--tm-cursor': 'bar' });
    assert.equal(r.windowRules.length, 1);
    assert.equal(r.windowRules[0].app, 'terminal');
    assert.equal(r.windowRules[0].vars['--win-frame'], '#00ff00');
    assert.equal(T.resolve({ apps: { terminal: { vars: { '--tm-cursor': 'underline; x' } } } }, REG).appRules.length, 0, 'select values must be declared options');
    const bad = [{ id: 'x', theme: { root: '.a{}body', vars: [{ key: '--v', type: 'color' }] } }];
    assert.equal(T.resolve({ apps: { x: { vars: { '--v': '#fff' } } } }, bad).appRules.length, 0, 'a selector with braces is refused');
});

test('colour maths round-trips', () => {
    assert.equal(T.util.hex(T.util.parse('#abc')), '#aabbcc');
    assert.equal(T.util.hex(T.util.parse('#ffffff80'), true), '#ffffff80');
    assert.equal(T.util.parse('red'), null);
    assert.equal(T.util.mix('#000000', '#ffffff', .5), '#808080');
    assert.equal(T.util.shade('#808080', .1), '#9a9a9a');
    assert.equal(T.util.rgba('#fc82b8', .5), 'rgba(252, 130, 184, 0.5)');
});
