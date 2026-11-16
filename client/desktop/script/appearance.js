/**
 * Appearance ("Personalize"): the window where the user customizes the desktop background, the taskbar, the window frames and,
 * per application, that application's own colours. The form is generated (lib/lprops.js); what it stores and how it is applied
 * is lib/ltheme.js. The per-application section is built from `theme.vars` in apps/registry.json, so a new themeable app shows
 * up here without touching this file.
 *
 * Edits preview live. OK / Apply saves them (to the user's appdata on the server, so they follow the user everywhere);
 * closing without applying puts the saved look back.
 */
(function () {
    var ui = __ui;
    document.desktopState = document.desktopState || {};

    var IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
    var opt = function (v, l) { return { value: v, label: l }; };

    function build(registry, saved) {
        var themed = registry.filter(function (a) { return a.theme && a.theme.vars && a.theme.vars.length; });
        var touched = new Set();
        var base = saved || {};

        // Which settings were customized before? Only those are stored again: the others keep following the preset.
        (Object.keys(base.colors || {})).forEach(function (k) { touched.add('c:' + k); });
        ['frame', 'header', 'headerInactive', 'headerInk', 'body'].forEach(function (k) { if ((base.windows || {})[k]) touched.add('w:' + k); });
        ['bg', 'ink'].forEach(function (k) { if ((base.taskbar || {})[k]) touched.add('t:' + k); });
        Object.keys(base.apps || {}).forEach(function (id) {
            Object.keys(base.apps[id].vars || {}).forEach(function (k) { touched.add('a:' + id + ':' + k); });
            ['frame', 'header'].forEach(function (k) { if (base.apps[id][k]) touched.add('a:' + id + ':' + k); });
        });

        function defaults(a) {
            var r = __theme.resolve(a, registry, auth_url);
            return r.vars;
        }
        function auth_url(p) { return auth.fileUrl(p); }

        /** current value to show for every field, from an appearance */
        function toValues(a) {
            a = a || {};
            var v = defaults(a), d = a.desktop || {}, t = a.taskbar || {}, w = a.windows || {}, out = {};
            out.preset = a.preset || 'candy';
            __theme.COLOR_TOKENS.forEach(function (c) { out['c:' + c[0]] = (a.colors || {})[c[0]] || v[c[0]]; });
            out.d_mode = d.mode || 'gradient'; out.d_color = d.color || v['--bg-main']; out.d_image = d.image || ''; out.d_fit = d.fit || 'cover'; out.d_dim = d.dim || 0;
            out.t_position = t.position || 'bottom'; out.t_height = t.height || 42; out.t_opacity = t.opacity === undefined ? 100 : t.opacity;
            out['t:bg'] = t.bg || v['--taskbar-bg'].slice(0, 7); out['t:ink'] = t.ink || v['--taskbar-ink'];
            ['labels', 'clock', 'date', 'tray'].forEach(function (k) { out['t_' + k] = t[k] !== false; });
            out.t_hour12 = t.hour12 || 'auto';
            out['w:frame'] = w.frame || v['--win-frame']; out['w:header'] = w.header || v['--win-header-background'];
            out['w:headerInactive'] = w.headerInactive || v['--win-header-background-inactive']; out['w:headerInk'] = w.headerInk || v['--win-header-color'];
            out['w:body'] = w.body || v['--win-body-background'];
            out.w_radius = w.radius === undefined ? 8 : w.radius; out.w_border = w.border === undefined ? 4 : w.border;
            out.w_shadow = w.shadow || 'soft'; out.w_titleFont = w.titleFont || 'pixel'; out.w_buttons = w.buttons || 'square'; out.w_animations = w.animations !== false;
            out.app = themed.length ? themed[0].id : '';
            themed.forEach(function (app) {
                var conf = (a.apps || {})[app.id] || {};
                app.theme.vars.forEach(function (def) {
                    var cur = (conf.vars || {})[def.key];
                    out['a:' + app.id + ':' + def.key] = cur !== undefined ? cur : (def.inherit ? v[def.inherit] : def.default);
                });
                out['a:' + app.id + ':frame'] = conf.frame || v['--win-frame'];
                out['a:' + app.id + ':header'] = conf.header || v['--win-header-background'];
            });
            return out;
        }

        /** form values -> the appearance to store (only what was changed from the preset's own values) */
        function fromValues(v) {
            var a = { preset: v.preset, colors: {}, desktop: {}, taskbar: {}, windows: {}, apps: {} };
            __theme.COLOR_TOKENS.forEach(function (c) { if (touched.has('c:' + c[0])) a.colors[c[0]] = v['c:' + c[0]]; });
            a.desktop.mode = v.d_mode; a.desktop.fit = v.d_fit; a.desktop.dim = v.d_dim || 0;
            if (v.d_mode === 'color' || (v.d_mode === 'image' && touched.has('d_color'))) a.desktop.color = v.d_color;
            if (v.d_mode === 'image' && v.d_image) a.desktop.image = v.d_image; else if (v.d_mode === 'image') a.desktop.mode = 'gradient';
            a.taskbar = { position: v.t_position, height: v.t_height, opacity: v.t_opacity, labels: v.t_labels, clock: v.t_clock, date: v.t_date, tray: v.t_tray, hour12: v.t_hour12 };
            if (touched.has('t:bg')) a.taskbar.bg = v['t:bg'].slice(0, 7);
            if (touched.has('t:ink')) a.taskbar.ink = v['t:ink'].slice(0, 7);
            ['frame', 'header', 'headerInactive', 'headerInk', 'body'].forEach(function (k) { if (touched.has('w:' + k)) a.windows[k] = v['w:' + k]; });
            a.windows.radius = v.w_radius; a.windows.border = v.w_border; a.windows.shadow = v.w_shadow; a.windows.titleFont = v.w_titleFont; a.windows.buttons = v.w_buttons; a.windows.animations = v.w_animations;
            themed.forEach(function (app) {
                var entry = { vars: {} };
                app.theme.vars.forEach(function (def) {
                    var k = 'a:' + app.id + ':' + def.key;
                    if (touched.has(k) && v[k] !== null && v[k] !== '') entry.vars[def.key] = def.type === 'number' ? Number(v[k]) : v[k];
                });
                ['frame', 'header'].forEach(function (k) { if (touched.has('a:' + app.id + ':' + k)) entry[k] = v['a:' + app.id + ':' + k]; });
                if (Object.keys(entry.vars).length || entry.frame || entry.header) a.apps[app.id] = entry;
            });
            if (!Object.keys(a.colors).length) delete a.colors;
            if (!Object.keys(a.apps).length) delete a.apps;
            return a;
        }

        /* ---------------------------------------------------------------------------------- fields */
        var theme = [
            { type: 'group', text: 'Base look' },
            { key: 'preset', label: 'Theme', type: 'swatches', options: __theme.PRESET_ORDER.map(function (id) { return { value: id, label: __theme.PRESETS[id].label, color: __theme.PRESETS[id].swatch }; }),
              help: 'Candy is the original look.' },
            { key: 'c:--accent', label: 'Accent colour', type: 'color', help: 'Buttons, selection, highlights. The lighter / darker shades and the text colour on it follow automatically.' },
            { type: 'group', text: 'Fine tuning' },
            { type: 'note', text: 'Only the colours you change here are kept; the others keep following the theme above.' }
        ].concat(__theme.COLOR_TOKENS.filter(function (c) { return c[0] !== '--accent'; }).map(function (c) { return { key: 'c:' + c[0], label: c[1], type: 'color' }; }));

        var desktop = [
            { key: 'd_mode', label: 'Background', type: 'select', options: [opt('gradient', 'Default gradient'), opt('color', 'Solid colour'), opt('image', 'Picture from my files')] },
            { key: 'd_color', label: 'Colour', type: 'color', showIf: function (v) { return v.d_mode === 'color'; } },
            { key: 'd_image', label: 'Picture', type: 'path', pick: 'file', exts: IMG, title: 'Choose a wallpaper', start: '/pictures', showIf: function (v) { return v.d_mode === 'image'; },
              help: 'Upload pictures with the Explorer first (e.g. into /pictures).', validate: function (v, all) { return all.d_mode === 'image' && v && v.charAt(0) !== '/' ? 'Use an absolute path like /pictures/wall.png' : ''; } },
            { key: 'd_fit', label: 'Fit', type: 'select', showIf: function (v) { return v.d_mode === 'image'; }, options: [opt('cover', 'Fill (crop)'), opt('contain', 'Fit inside'), opt('stretch', 'Stretch'), opt('center', 'Centre'), opt('tile', 'Tile')] },
            { key: 'd_dim', label: 'Dim', type: 'range', min: 0, max: 80, step: 5, unit: '%', help: 'Darkens the background so icons stay readable on a bright picture.' }
        ];

        var taskbar = [
            { key: 't_position', label: 'Position', type: 'select', options: [opt('bottom', 'Bottom'), opt('top', 'Top')] },
            { key: 't_height', label: 'Height', type: 'range', min: 30, max: 72, step: 2, unit: 'px' },
            { key: 't:bg', label: 'Colour', type: 'color' },
            { key: 't:ink', label: 'Text colour', type: 'color' },
            { key: 't_opacity', label: 'Opacity', type: 'range', min: 30, max: 100, step: 5, unit: '%' },
            { type: 'group', text: 'Show' },
            { key: 't_labels', label: 'Window names', type: 'checkbox', text: 'Show the title next to the icon on task buttons' },
            { key: 't_clock', label: 'Clock', type: 'checkbox', text: 'Show the time' },
            { key: 't_date', label: 'Date', type: 'checkbox', text: 'Show the date' },
            { key: 't_tray', label: 'Connection', type: 'checkbox', text: 'Show the connection indicator' },
            { key: 't_hour12', label: 'Time format', type: 'select', options: [opt('auto', 'Follow my browser'), opt('24', '24-hour'), opt('12', '12-hour')] }
        ];

        var windows = [
            { key: 'w:frame', label: 'Frame', type: 'color' },
            { key: 'w:header', label: 'Title bar', type: 'color' },
            { key: 'w:headerInactive', label: 'Title bar (not in front)', type: 'color' },
            { key: 'w:headerInk', label: 'Title text', type: 'color' },
            { key: 'w:body', label: 'Window background', type: 'color' },
            { type: 'group', text: 'Shape' },
            { key: 'w_radius', label: 'Corner radius', type: 'range', min: 0, max: 24, step: 1, unit: 'px' },
            { key: 'w_border', label: 'Frame thickness', type: 'range', min: 0, max: 10, step: 1, unit: 'px' },
            { key: 'w_shadow', label: 'Shadow', type: 'select', options: [opt('soft', 'Soft'), opt('strong', 'Strong'), opt('none', 'None')] },
            { key: 'w_titleFont', label: 'Title font', type: 'select', options: [opt('pixel', 'Pixel (original)'), opt('ui', 'Interface font')] },
            { key: 'w_buttons', label: 'Buttons', type: 'select', options: [opt('square', 'Rounded squares'), opt('round', 'Circles')] },
            { key: 'w_animations', label: 'Animation', type: 'checkbox', text: 'Animate windows opening' }
        ];

        var appFields = [
            { key: 'app', label: 'Application', type: 'select', options: themed.map(function (a) { return opt(a.id, a.name); }) },
            { type: 'note', text: 'Each application can have its own colours. Only the ones you change are kept.' }
        ];
        themed.forEach(function (app) {
            var show = function (v) { return v.app === app.id; };
            app.theme.vars.forEach(function (def) {
                var f = { key: 'a:' + app.id + ':' + def.key, label: def.label, type: def.type === 'number' ? 'range' : def.type, showIf: show };
                if (def.type === 'number') { f.min = def.min; f.max = def.max; f.step = def.step || 1; f.unit = def.unit; }
                if (def.type === 'select') f.options = def.options;
                appFields.push(f);
            });
            appFields.push({ key: 'a:' + app.id + ':frame', label: 'Window frame', type: 'color', showIf: show });
            appFields.push({ key: 'a:' + app.id + ':header', label: 'Window title bar', type: 'color', showIf: show });
        });

        var tabs = [{ id: 'theme', label: 'Theme', fields: theme }, { id: 'desktop', label: 'Desktop', fields: desktop }, { id: 'taskbar', label: 'Taskbar', fields: taskbar },
            { id: 'windows', label: 'Windows', fields: windows }];
        if (themed.length) tabs.push({ id: 'apps', label: 'Applications', fields: appFields });
        return { tabs: tabs, toValues: toValues, fromValues: fromValues, touched: touched, themed: themed };
    }

    var win = null;
    document.desktopState.openAppearance = function (tabId) {
        if (win) { win.focus(); return; }
        ctxApps().list().then(function (registry) {
            var form = build(registry, __theme.saved());
            var values = form.toValues(__theme.saved());
            var base = JSON.parse(JSON.stringify(__theme.saved()));

            function untouchedRefresh(api, preset) {   // a new preset changes every colour that the user has not customized
                var a = { preset: preset }, v = form.toValues(a);
                Object.keys(v).forEach(function (k) { if (/^(c|w|t|a):/.test(k) && !form.touched.has(k)) api.setValue(k, v[k]); });
            }
            win = __props.open({
                id: 'appearance', title: 'Personalize', subtitle: 'Desktop, taskbar, windows and applications', icon: 'palette', size: [600, 600], minSize: [420, 380],
                tabs: form.tabs, values: values, applyLabel: 'OK',
                actions: [{ label: 'Reset everything', icon: 'refresh', onClick: function (api) {
                    ui.confirm({ title: 'Reset appearance', message: 'Go back to the original look? Your colours, wallpaper and per-application themes will be forgotten.', confirmText: 'Reset', danger: true }).then(function (yes) {
                        if (!yes) return;
                        __theme.reset().then(function () { form.touched.clear(); api.setValues(form.toValues({})); api.markClean(); ui.toast('Appearance reset', 'ok'); }, function (err) { api.setBanner(ui.errorText(err)); });
                    });
                } }],
                onChange: function (v, key, api) {
                    if (key === 'preset') untouchedRefresh(api, v.preset);
                    if (/^(c|w|t|a):/.test(key)) form.touched.add(key);
                    if (key === 'd_color') form.touched.add('d_color');
                    __theme.preview(form.fromValues(api.getValues()));
                },
                onApply: function (v) { return __theme.commit(form.fromValues(v)); },
                onClose: function (applied) { win = null; if (!applied) __theme.revert(); }
            });
            if (tabId && win) setTimeout(function () { var b = document.querySelector('.pr-tab[data-tab="' + tabId + '"]'); if (b) b.click(); }, 0);
        });
    };
    function ctxApps() { return __apps.getInstance(); }
})();
