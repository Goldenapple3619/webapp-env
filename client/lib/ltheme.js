var __theme = (() => {
    var CACHE_KEY = 'webapp.appearance.v1';
    var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
    var VAR = /^--[a-z][a-z0-9-]{0,40}$/;

    function parse(hex) {
        hex = String(hex).toLowerCase();
        if (!HEX.test(hex)) return null;
        var h = hex.slice(1);
        if (h.length <= 4) h = h.split('').map(function (c) { return c + c; }).join('');
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    function two(n) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0'); }
    function hex(c, withAlpha) { return '#' + two(c.r) + two(c.g) + two(c.b) + (withAlpha && c.a < 1 ? two(c.a * 255) : ''); }
    function toHsl(c) {
        var r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
        if (max !== min) {
            var d = max - min;
            s = l > .5 ? d / (2 - max - min) : d / (max + min);
            h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h /= 6;
        }
        return { h: h, s: s, l: l };
    }
    function fromHsl(x) {
        function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
        if (x.s === 0) return { r: x.l * 255, g: x.l * 255, b: x.l * 255, a: 1 };
        var q = x.l < .5 ? x.l * (1 + x.s) : x.l + x.s - x.l * x.s, p = 2 * x.l - q;
        return { r: f(p, q, x.h + 1 / 3) * 255, g: f(p, q, x.h) * 255, b: f(p, q, x.h - 1 / 3) * 255, a: 1 };
    }
    function shade(h, dl, ds) {
        var c = parse(h); if (!c) return h;
        var x = toHsl(c);
        x.l = Math.max(0, Math.min(1, x.l + dl));
        if (ds) x.s = Math.max(0, Math.min(1, x.s * ds));
        return hex(fromHsl(x));
    }
    function mix(a, b, t) {
        var x = parse(a), y = parse(b); if (!x || !y) return a;
        return hex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 });
    }
    function lum(c) {
        function ch(v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }
        return .2126 * ch(c.r) + .7152 * ch(c.g) + .0722 * ch(c.b);
    }
    function contrast(a, b) {
        var x = parse(a), y = parse(b); if (!x || !y) return 1;
        var l1 = lum(x), l2 = lum(y);
        return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
    }

    function inkOn(bg, prefer) {
        var c = parse(bg); if (!c) return '#ffffff';
        var h = toHsl(c).h;
        var dark = hex(fromHsl({ h: h, s: .6, l: .13, a: 1 })), darker = hex(fromHsl({ h: h, s: .5, l: .03, a: 1 }));
        if (prefer === 'light' && contrast('#ffffff', bg) >= 3) return '#ffffff';
        if (contrast(dark, bg) >= 4.5) return dark;
        if (contrast('#ffffff', bg) >= 4.5) return '#ffffff';
        return contrast(darker, bg) >= contrast('#ffffff', bg) ? darker : '#ffffff';
    }
    function rgba(h, a) { var c = parse(h) || { r: 0, g: 0, b: 0 }; return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a + ')'; }
    function withAlpha(h, a) { var c = parse(h); return c ? hex({ r: c.r, g: c.g, b: c.b, a: a }, true) : h; }

    function deriveAccent(accent) {
        var c = parse(accent); if (!c) return {};
        var x = toHsl(c);
        return {
            '--accent': hex(c),
            '--accent-2': shade(accent, .06),
            '--accent-edge': shade(accent, -.11),
            '--accent-ink': hex(fromHsl({ h: x.h, s: Math.min(1, x.s * .6), l: .26, a: 1 })),
            '--on-accent': inkOn(accent)
        };
    }

    var PRESETS = {
        candy: {
            label: 'Candy', swatch: '#FC82B8',
            tokens: {
                '--bg-main': '#dcd4f0', '--bg-secondary': '#e0c6e7', '--bg-terciary': '#c1b1e6', '--bg-quaduary': '#bba1f0',
                '--border-secondary': '#b397ed', '--border-terciary': '#ae99d9', '--border-quaduary': '#ae99d9', '--separator': '#b99adc',
                '--ink': '#2c1f4d', '--ink-soft': '#5b4a85', '--ink-faint': '#8a7cab', '--surface': '#f6f1fc', '--surface-2': '#efe6f8',
                '--accent': '#fc82b8', '--accent-2': '#fc9dc9', '--accent-edge': '#e2639d', '--accent-ink': '#6e1b45', '--on-accent': '#3b0d24',
                '--danger': '#b3264f', '--ok': '#2c7d5f', '--win-body-background': '#fae3ed',
                '--hover': '#ffffff8c', '--hover-strong': '#ffffff', '--scroll-thumb': '#ae99d9d6', '--scroll-thumb-hover': '#9784bd', '--scroll-track-color': '#ae99d9', '--overlay': '#2c1f4d6b'
            },
            windows: { frame: '#fc82b8', header: '#fc9dc9', headerInactive: '#f3bdd6', headerInk: '#ffffff', buttonBg: '#fffafe', buttonInk: '#8b3a63' }
        },
        midnight: {
            label: 'Midnight', swatch: '#2a2342',
            tokens: {
                '--bg-main': '#1d1830', '--bg-secondary': '#2a2342', '--bg-terciary': '#342b52', '--bg-quaduary': '#4a3d78',
                '--border-secondary': '#5b4a96', '--border-terciary': '#4d3f80', '--border-quaduary': '#5a4b94', '--separator': '#5e4f9c',
                '--ink': '#ece6ff', '--ink-soft': '#b9aee0', '--ink-faint': '#8478b3', '--surface': '#2f2749', '--surface-2': '#3a3158',
                '--accent': '#fc82b8', '--accent-2': '#fc9dc9', '--accent-edge': '#e2639d', '--accent-ink': '#ffb7d9', '--on-accent': '#2b0a1b',
                '--danger': '#ff7a9c', '--ok': '#6fd6a8', '--win-body-background': '#262040',
                '--hover': '#ffffff1f', '--hover-strong': '#ffffff33', '--scroll-thumb': '#6b5aa8d6', '--scroll-thumb-hover': '#8672cc', '--scroll-track-color': '#6b5aa8', '--overlay': '#0a0614a8'
            },
            windows: { frame: '#5b4a96', header: '#4a3d78', headerInactive: '#352c58', headerInk: '#ece6ff', buttonBg: '#3a3158', buttonInk: '#ece6ff' }
        },
        mint: {
            label: 'Mint', swatch: '#2fb67c',
            tokens: {
                '--bg-main': '#d5ecdf', '--bg-secondary': '#c3e3d3', '--bg-terciary': '#a9d6c0', '--bg-quaduary': '#86c6a6',
                '--border-secondary': '#6fb593', '--border-terciary': '#7fbd9f', '--border-quaduary': '#7fbd9f', '--separator': '#6fb593',
                '--ink': '#17382b', '--ink-soft': '#3f6b59', '--ink-faint': '#6f9884', '--surface': '#f1faf5', '--surface-2': '#e3f4eb',
                '--accent': '#2fb67c', '--accent-2': '#4fd197', '--accent-edge': '#1f8f5e', '--accent-ink': '#0f4a31', '--on-accent': '#062a1b',
                '--danger': '#b3264f', '--ok': '#1f8f5e', '--win-body-background': '#e8f6ef',
                '--hover': '#ffffff8c', '--hover-strong': '#ffffff', '--scroll-thumb': '#6fb593d6', '--scroll-thumb-hover': '#4f9a78', '--scroll-track-color': '#6fb593', '--overlay': '#0f2a1f6b'
            },
            windows: { frame: '#2fb67c', header: '#4fd197', headerInactive: '#a5dfc3', headerInk: '#062a1b', buttonBg: '#f1faf5', buttonInk: '#0f4a31' }
        },
        slate: {
            label: 'Slate', swatch: '#4d8bf5',
            tokens: {
                '--bg-main': '#d9dde4', '--bg-secondary': '#cbd1db', '--bg-terciary': '#b8c0ce', '--bg-quaduary': '#9aa6bd',
                '--border-secondary': '#8493ad', '--border-terciary': '#93a0b6', '--border-quaduary': '#93a0b6', '--separator': '#8493ad',
                '--ink': '#1c2433', '--ink-soft': '#475269', '--ink-faint': '#7a869c', '--surface': '#f4f6fa', '--surface-2': '#e8ecf3',
                '--accent': '#4d8bf5', '--accent-2': '#7aa8f8', '--accent-edge': '#2f6fe0', '--accent-ink': '#173f87', '--on-accent': '#071a3d',
                '--danger': '#b3264f', '--ok': '#2c7d5f', '--win-body-background': '#eef1f6',
                '--hover': '#ffffff8c', '--hover-strong': '#ffffff', '--scroll-thumb': '#8493add6', '--scroll-thumb-hover': '#66769a', '--scroll-track-color': '#8493ad', '--overlay': '#1c24336b'
            },
            windows: { frame: '#4d8bf5', header: '#7aa8f8', headerInactive: '#b7cdf5', headerInk: '#071a3d', buttonBg: '#f4f6fa', buttonInk: '#173f87' }
        }
    };
    var PRESET_ORDER = ['candy', 'midnight', 'mint', 'slate'];

    var COLOR_TOKENS = [
        ['--bg-main', 'Desktop / base'], ['--bg-secondary', 'Panels'], ['--bg-terciary', 'Toolbars'], ['--bg-quaduary', 'Strong panels'],
        ['--surface', 'Fields & cards'], ['--surface-2', 'Inset areas'], ['--ink', 'Text'], ['--ink-soft', 'Secondary text'],
        ['--border-secondary', 'Panel borders'], ['--border-quaduary', 'Control borders'], ['--separator', 'Separators'],
        ['--accent', 'Accent (re-derives the family below)'], ['--accent-2', 'Accent, light'], ['--accent-edge', 'Accent, edge'],
        ['--accent-ink', 'Accent text'], ['--on-accent', 'Text on accent'], ['--danger', 'Danger'], ['--ok', 'OK'], ['--win-body-background', 'Window background']
    ];

    var SHADOWS = {
        none: ['none', 'none'],
        soft: ['0 12px 28px -8px rgba(44, 31, 77, .45), 0 2px 6px rgba(44, 31, 77, .25)', '0 4px 12px -4px rgba(44, 31, 77, .3)'],
        strong: ['0 22px 48px -8px rgba(0, 0, 0, .6), 0 4px 10px rgba(0, 0, 0, .35)', '0 8px 20px -6px rgba(0, 0, 0, .45)']
    };
    var FITS = {
        cover: ['cover', 'no-repeat', 'center'], contain: ['contain', 'no-repeat', 'center'], center: ['auto', 'no-repeat', 'center'],
        tile: ['auto', 'repeat', '0 0'], stretch: ['100% 100%', 'no-repeat', 'center']
    };

    function clamp(n, lo, hi) { n = Number(n); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }
    function isHex(v) { return typeof v === 'string' && HEX.test(v); }
    function safeUrl(u) { return typeof u === 'string' ? u.replace(/["'\\()\s\x00-\x1f]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase(); }) : ''; }

    function resolve(a, registry, fileUrl) {
        a = a && typeof a === 'object' ? a : {};
        var preset = PRESETS[a.preset] || PRESETS.candy;
        var colors = {};
        Object.keys(a.colors || {}).forEach(function (k) { if (VAR.test(k) && isHex(a.colors[k])) colors[k] = hex(parse(a.colors[k]), true); });
        var tokens = Object.assign({}, preset.tokens, colors['--accent'] ? deriveAccent(colors['--accent']) : {}, colors);
        var vars = {}, unset = [], attrs = {};
        Object.keys(tokens).forEach(function (k) { vars[k] = tokens[k]; });
        var accent = tokens['--accent'];
        vars['--selection'] = rgba(accent, .28);
        vars['--focus-ring'] = '0 0 0 3px ' + rgba(accent, .55);

        var w = a.windows || {}, pw = preset.windows;
        var accentChanged = !!colors['--accent'] && !isHex(w.frame);
        var frame = isHex(w.frame) ? w.frame : (accentChanged ? accent : pw.frame);
        var header = isHex(w.header) ? w.header : (accentChanged ? tokens['--accent-2'] : pw.header);
        var headerInactive = isHex(w.headerInactive) ? w.headerInactive : ((isHex(w.header) || accentChanged) ? mix(header, tokens['--bg-main'], .45) : pw.headerInactive);
        var headerInk = isHex(w.headerInk) ? w.headerInk : ((isHex(w.header) || accentChanged) ? inkOn(header, 'light') : pw.headerInk);
        var lightInk = contrast(headerInk, '#000000') > 8;
        vars['--win-frame'] = frame;
        vars['--win-header-background'] = header;
        vars['--win-header-background-inactive'] = headerInactive;
        vars['--win-header-color'] = headerInk;
        vars['--win-header-shadow'] = lightInk ? '0 1px 0 rgba(0, 0, 0, .28)' : 'none';
        vars['--win-button-bg'] = (isHex(w.header) || accentChanged) ? mix(header, '#ffffff', .88) : pw.buttonBg;
        vars['--win-button-ink'] = (isHex(w.header) || accentChanged) ? inkOn(mix(header, '#ffffff', .88)) : pw.buttonInk;
        if (isHex(w.body)) vars['--win-body-background'] = w.body.toLowerCase();
        vars['--win-radius'] = clamp(w.radius === undefined ? 8 : w.radius, 0, 24) + 'px';
        vars['--win-border-width'] = clamp(w.border === undefined ? 4 : w.border, 0, 10) + 'px';
        var sh = SHADOWS[w.shadow] || SHADOWS.soft;
        vars['--win-shadow'] = sh[0]; vars['--win-shadow-blur'] = sh[1];
        vars['--win-header-font-family'] = w.titleFont === 'ui' ? 'var(--font-ui)' : 'var(--font-pixel)';
        attrs['data-win-buttons'] = w.buttons === 'round' ? 'round' : 'square';
        attrs['data-win-anim'] = w.animations === false ? 'off' : 'on';

        var t = a.taskbar || {};
        var tbBg = isHex(t.bg) ? t.bg.toLowerCase() : tokens['--bg-secondary'];
        var opacity = clamp(t.opacity === undefined ? 100 : t.opacity, 30, 100);
        vars['--taskbar-height'] = clamp(t.height === undefined ? 42 : t.height, 30, 72) + 'px';
        vars['--taskbar-bg'] = opacity < 100 ? withAlpha(tbBg, opacity / 100) : tbBg;
        vars['--taskbar-ink'] = isHex(t.ink) ? t.ink.toLowerCase() : (isHex(t.bg) ? inkOn(tbBg) : tokens['--ink']);
        vars['--taskbar-edge'] = tokens['--border-secondary'];
        vars['--taskbar-backdrop'] = opacity < 100 ? 'blur(8px)' : 'none';
        attrs['data-taskbar'] = t.position === 'top' ? 'top' : 'bottom';
        ['labels', 'clock', 'date', 'tray'].forEach(function (k) { attrs['data-taskbar-' + k] = t[k] === false ? 'off' : 'on'; });

        var d = a.desktop || {}, mode = d.mode;
        if (mode === 'color' && isHex(d.color)) {
            vars['--desktop-color'] = d.color.toLowerCase(); vars['--desktop-image'] = 'none';
            unset.push('--desktop-size', '--desktop-repeat', '--desktop-position');
        } else if (mode === 'image' && typeof d.image === 'string' && d.image.charAt(0) === '/' && fileUrl) {
            var fit = FITS[d.fit] || FITS.cover;
            vars['--desktop-image'] = 'url("' + safeUrl(fileUrl(d.image)) + '")';
            vars['--desktop-size'] = fit[0]; vars['--desktop-repeat'] = fit[1]; vars['--desktop-position'] = fit[2];
            if (isHex(d.color)) vars['--desktop-color'] = d.color.toLowerCase(); else unset.push('--desktop-color');
        } else {
            unset.push('--desktop-color', '--desktop-image', '--desktop-size', '--desktop-repeat', '--desktop-position');
        }
        vars['--desktop-dim'] = String(clamp(d.dim || 0, 0, 80) / 100);

        var appRules = [], windowRules = [];
        (registry || []).forEach(function (app) {
            var conf = (a.apps || {})[app.id];
            if (!conf) return;
            var defs = (app.theme && app.theme.vars) || [], out = {};
            defs.forEach(function (def) {
                var v = conf.vars && conf.vars[def.key];
                if (v === undefined) return;
                if (def.type === 'color' && isHex(v)) out[def.key] = v.toLowerCase();
                else if (def.type === 'number' && typeof v === 'number') out[def.key] = clamp(v, def.min === undefined ? -1e5 : def.min, def.max === undefined ? 1e5 : def.max) + (def.unit || '');
                else if (def.type === 'select' && (def.options || []).some(function (o) { return o.value === v; })) out[def.key] = String(v);
            });
            if (Object.keys(out).length && app.theme && /^[.#a-zA-Z][\w .#>-]*$/.test(app.theme.root || '')) appRules.push({ selector: 'html body ' + app.theme.root, vars: out });
            var wv = {};
            if (isHex(conf.frame)) wv['--win-frame'] = conf.frame.toLowerCase();
            if (isHex(conf.header)) {
                wv['--win-header-background'] = conf.header.toLowerCase();
                wv['--win-header-background-inactive'] = mix(conf.header, tokens['--bg-main'], .45);
                wv['--win-header-color'] = inkOn(conf.header, 'light');
            }
            if (Object.keys(wv).length) windowRules.push({ app: app.id, vars: wv });
        });
        return { vars: vars, unset: unset, attrs: attrs, appRules: appRules, windowRules: windowRules };
    }

    var state = { saved: null, shown: null, registry: [], fileUrl: null, listeners: [], handleProvider: null, tabId: Math.random().toString(36).slice(2) + Date.now().toString(36), applied: [] };

    function sheet() {
        var el = document.getElementById('theme-apps');
        if (!el) { el = document.createElement('style'); el.id = 'theme-apps'; document.head.appendChild(el); }
        return el.sheet;
    }
    function applyResolved(r) {
        var root = document.documentElement;
        Object.keys(r.vars).forEach(function (k) { root.style.setProperty(k, r.vars[k]); });
        r.unset.forEach(function (k) { root.style.removeProperty(k); });
        Object.keys(r.attrs).forEach(function (k) { root.setAttribute(k, r.attrs[k]); });
        var s = sheet();
        if (!s) return;
        while (s.cssRules.length) s.deleteRule(0);
        function add(selector, vars) {
            var i = s.insertRule(selector + ' {}', s.cssRules.length);
            Object.keys(vars).forEach(function (k) { s.cssRules[i].style.setProperty(k, vars[k]); });
        }
        r.appRules.forEach(function (rule) { try { add(rule.selector, rule.vars); } catch (e) { /* a registry selector the browser rejects */ } });
        r.windowRules.forEach(function (rule) { add('.window[data-app="' + rule.app.replace(/[^\w-]/g, '') + '"]', rule.vars); });
    }
    function show(a) {
        state.shown = a;
        applyResolved(resolve(a, state.registry, state.fileUrl));
        state.listeners.forEach(function (fn) { try { fn(a); } catch (e) { console.error(e); } });
    }
    function cache(a) { try { if (a) localStorage.setItem(CACHE_KEY, JSON.stringify(a)); else localStorage.removeItem(CACHE_KEY); } catch (e) { /* private mode */ } }
    function cached() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; } }

    function handle() { return state.handleProvider ? state.handleProvider() : Promise.reject(new Error('theme: not connected')); }

    var api = {
        PRESETS: PRESETS, PRESET_ORDER: PRESET_ORDER, COLOR_TOKENS: COLOR_TOKENS, FITS: Object.keys(FITS),
        util: { parse: parse, hex: hex, shade: shade, mix: mix, contrast: contrast, inkOn: inkOn, deriveAccent: deriveAccent, rgba: rgba, withAlpha: withAlpha, toHsl: toHsl },
        resolve: resolve, tabId: state.tabId,

        configure: function (opts) {
            if (opts.registry) state.registry = opts.registry;
            if (opts.fileUrl) state.fileUrl = opts.fileUrl;
            if (opts.handle) state.handleProvider = opts.handle;
            if (state.shown) show(state.shown);
        },
        current: function () { return state.shown || state.saved || {}; },
        saved: function () { return state.saved || {}; },
        onChange: function (fn) { state.listeners.push(fn); },

        preview: function (a) { show(a); },
        revert: function () { show(state.saved || {}); },

        applyCached: function () { var c = cached(); if (c) { state.saved = c; show(c); } },

        load: function () {
            return handle().then(function (h) {
                h.on('desktop_changed', function (ev) { if (ev.kind === 'appearance' && ev.origin !== state.tabId) api.reload(); });
                h.on('restore', function () { api.reload(); });
                return api.reload();
            });
        },
        reload: function () {
            return handle().then(function (h) { return h.fetch('appearance'); }).then(function (r) {
                state.saved = r.appearance || null; cache(state.saved); show(state.saved || {});
                return state.saved;
            });
        },
        commit: function (a) {
            return handle().then(function (h) { return h.update('appearance_save', { appearance: a, origin: state.tabId }); }).then(function (r) {
                state.saved = r.appearance; cache(state.saved); show(state.saved);
                return state.saved;
            });
        },
        reset: function () {
            return handle().then(function (h) { return h.update('appearance_reset', { origin: state.tabId }); }).then(function () {
                state.saved = null; cache(null); show({});
            });
        },
        forgetCache: function () { cache(null); }
    };
    return api;
})();

if (typeof document !== 'undefined' && document.head) { try { __theme.applyCached(); } catch (e) {} }
if (typeof module !== 'undefined') module.exports = __theme;
