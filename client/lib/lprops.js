var __props = (() => {
    var openWindows = {};
    var spriteNames = null;

    function sprite() {
        if (spriteNames) return spriteNames;
        spriteNames = fetch('/assets/images/icons.svg').then(function (r) { return r.text(); }).then(function (t) {
            var out = [], re = /<symbol[^>]*\bid="([^"]+)"/g, m;
            while ((m = re.exec(t))) out.push(m[1]);
            return out.sort();
        }).catch(function () { return []; });
        return spriteNames;
    }

    function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
    function uid() { return 'pr' + Math.random().toString(36).slice(2, 9); }

    var CONTROLS = {
        text: function (f, emit, id) {
            var i = h('input', 'input'); i.type = 'text'; i.id = id; i.spellcheck = false; i.autocomplete = 'off';
            if (f.placeholder) i.placeholder = f.placeholder;
            if (f.maxlength) i.maxLength = f.maxlength;
            i.addEventListener('input', emit);
            return { node: i, get: function () { return i.value; }, set: function (v) { i.value = v == null ? '' : v; }, focus: function () { i.focus(); } };
        },
        textarea: function (f, emit, id) {
            var i = h('textarea', 'input'); i.id = id; i.rows = f.rows || 4; i.style.padding = '8px 12px'; i.style.resize = 'vertical';
            i.addEventListener('input', emit);
            return { node: i, get: function () { return i.value; }, set: function (v) { i.value = v == null ? '' : v; }, focus: function () { i.focus(); } };
        },
        number: function (f, emit, id) {
            var wrap = h('div', 'pr-inline'), i = h('input', 'input'); i.type = 'number'; i.id = id;
            if (f.min !== undefined) i.min = f.min; if (f.max !== undefined) i.max = f.max; if (f.step !== undefined) i.step = f.step;
            i.addEventListener('input', emit); wrap.appendChild(i);
            if (f.unit) wrap.appendChild(h('span', 'muted', f.unit));
            return { node: wrap, get: function () { return i.value === '' ? null : Number(i.value); }, set: function (v) { i.value = v == null ? '' : v; }, focus: function () { i.focus(); } };
        },
        select: function (f, emit, id) {
            var s = h('select', 'input'); s.id = id;
            function fill(options) { s.textContent = ''; options.forEach(function (o) { var op = h('option', null, o.label); op.value = o.value; s.appendChild(op); }); }
            fill(f.options || []);
            s.addEventListener('change', emit);
            return { node: s, get: function () { return s.value; }, set: function (v) { if (![].some.call(s.options, function (o) { return o.value === String(v); })) { var op = h('option', null, String(v)); op.value = v; s.appendChild(op); } s.value = v == null ? '' : v; }, focus: function () { s.focus(); }, fill: fill };
        },
        checkbox: function (f, emit, id) {
            var l = h('label', 'pr-check'), i = h('input'); i.type = 'checkbox'; i.id = id;
            i.addEventListener('change', emit); l.appendChild(i); l.appendChild(h('span', null, f.text || ''));
            return { node: l, get: function () { return i.checked; }, set: function (v) { i.checked = !!v; }, focus: function () { i.focus(); } };
        },
        color: function (f, emit, id) {
            var wrap = h('div', 'pr-inline'), c = h('input', 'pr-color'), t = h('input', 'input');
            c.type = 'color'; c.id = id; t.type = 'text'; t.maxLength = 9; t.spellcheck = false; t.style.maxWidth = '110px'; t.setAttribute('aria-label', (f.label || 'colour') + ' (hex)');
            var ok = function (v) { return /^#[0-9a-f]{6}$/i.test(v); };
            c.addEventListener('input', function () { t.value = c.value; emit(); });
            t.addEventListener('input', function () { if (ok(t.value)) c.value = t.value; emit(); });
            wrap.appendChild(c); wrap.appendChild(t);
            return { node: wrap, get: function () { return t.value; }, set: function (v) { v = v || '#000000'; t.value = v; c.value = ok(v.slice(0, 7)) ? v.slice(0, 7) : '#000000'; }, focus: function () { c.focus(); } };
        },
        range: function (f, emit, id) {
            var wrap = h('div', 'pr-inline'), r = h('input', 'pr-range'), out = h('span', 'pr-range-out');
            r.type = 'range'; r.id = id; r.min = f.min; r.max = f.max; r.step = f.step || 1;
            var show = function () { out.textContent = r.value + (f.unit || ''); };
            r.addEventListener('input', function () { show(); emit(); });
            wrap.appendChild(r); wrap.appendChild(out);
            return { node: wrap, get: function () { return Number(r.value); }, set: function (v) { r.value = v == null ? f.min : v; show(); }, focus: function () { r.focus(); } };
        },
        path: function (f, emit, id) {
            var wrap = h('div', 'pr-inline'), i = h('input', 'input'), b = h('button', 'btn btn--sm', 'Browse…');
            i.type = 'text'; i.id = id; i.spellcheck = false; i.placeholder = f.placeholder || '/documents/…'; b.type = 'button';
            i.addEventListener('input', emit);
            b.addEventListener('click', function () {
                if (!window.__pick) return;
                __pick.path({ kind: f.pick || 'file', exts: f.exts, title: f.title, value: i.value, start: f.start }).then(function (p) { if (p) { i.value = p; emit(); } });
            });
            wrap.appendChild(i); wrap.appendChild(b);
            return { node: wrap, get: function () { return i.value; }, set: function (v) { i.value = v == null ? '' : v; }, focus: function () { i.focus(); } };
        },
        icon: function (f, emit, id) {
            var wrap = h('div', 'pr-inline'), prev = h('span', 'pr-icon'), sel = h('select', 'input'), b = h('button', 'btn btn--sm', 'Image…');
            prev.style.cssText = 'width:34px;height:34px;flex:none;border-radius:8px;background:var(--surface);display:grid;place-items:center;border:2px solid var(--border-quaduary);overflow:hidden';
            sel.id = id; b.type = 'button'; b.title = 'Use an image from your files';
            var value = '';
            function paint() {
                prev.textContent = '';
                if (!value) prev.innerHTML = '<span class="muted">·</span>';
                else if (value.charAt(0) === '/') { var im = h('img'); im.style.cssText = 'width:24px;height:24px;object-fit:contain'; im.alt = ''; im.src = window.auth ? auth.fileUrl(value) : value; prev.appendChild(im); }
                else prev.innerHTML = __ui.icon(value);
            }
            function options(extra) {
                sprite().then(function (names) {
                    sel.textContent = '';
                    var none = h('option', null, '(the application’s own icon)'); none.value = ''; sel.appendChild(none);
                    names.concat(extra && names.indexOf(extra) < 0 ? [extra] : []).forEach(function (n) { var o = h('option', null, n); o.value = n; sel.appendChild(o); });
                    if (value && value.charAt(0) === '/') { var o = h('option', null, value); o.value = value; sel.appendChild(o); }
                    sel.value = value;
                });
            }
            sel.addEventListener('change', function () { value = sel.value; paint(); emit(); });
            b.addEventListener('click', function () {
                if (!window.__pick) return;
                __pick.path({ kind: 'file', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'], title: 'Choose an icon image', start: '/pictures' }).then(function (p) {
                    if (p) { value = p; options(); paint(); emit(); }
                });
            });
            wrap.appendChild(prev); wrap.appendChild(sel); wrap.appendChild(b);
            options();
            return { node: wrap, get: function () { return value; }, set: function (v) { value = v || ''; options(); paint(); }, focus: function () { sel.focus(); } };
        },
        swatches: function (f, emit) {
            var wrap = h('div', 'pr-swatches'), value = null;
            (f.options || []).forEach(function (o) {
                var b = h('button', 'pr-swatch'); b.type = 'button'; b.dataset.value = o.value;
                var sw = h('i'); sw.style.background = o.color; b.appendChild(sw); b.appendChild(document.createTextNode(o.label));
                b.addEventListener('click', function () { value = o.value; paint(); emit(); });
                wrap.appendChild(b);
            });
            function paint() { wrap.querySelectorAll('.pr-swatch').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.value === value)); }); }
            return { node: wrap, get: function () { return value; }, set: function (v) { value = v; paint(); }, focus: function () { var b = wrap.querySelector('.pr-swatch'); if (b) b.focus(); } };
        },
        rows: function (f, emit) {
            // an editable table: columns = [{key, label, type: 'text'|'select', options, placeholder}]
            var wrap = h('div', 'pr-rows'), list = h('div', 'pr-rows'), cols = f.columns || [];
            var tpl = cols.map(function (c) { return c.width || '1fr'; }).join(' ');
            var head = h('div', 'pr-row pr-row-head'); head.style.setProperty('--cols', tpl);
            cols.forEach(function (c) { head.appendChild(h('span', null, c.label)); }); var sp = h('span'); sp.style.width = '32px'; head.appendChild(sp);
            var add = h('button', 'btn btn--sm', f.addLabel || 'Add'); add.type = 'button'; add.style.alignSelf = 'flex-start';
            function addRow(values) {
                if (list.children.length >= (f.max || 32)) return;
                var row = h('div', 'pr-row'); row.style.setProperty('--cols', tpl);
                cols.forEach(function (c) {
                    var control = c.type === 'select' ? h('select', 'input') : h('input', 'input');
                    if (c.type === 'select') (c.options || []).forEach(function (o) { var op = h('option', null, o.label); op.value = o.value; control.appendChild(op); });
                    else { control.type = 'text'; control.spellcheck = false; if (c.placeholder) control.placeholder = c.placeholder; if (c.suggest) { var dl = 'dl' + uid(); var d = h('datalist'); d.id = dl; c.suggest.forEach(function (s) { var o = h('option'); o.value = s; d.appendChild(o); }); row.appendChild(d); control.setAttribute('list', dl); } }
                    control.dataset.key = c.key; control.setAttribute('aria-label', c.label);
                    control.value = values && values[c.key] != null ? values[c.key] : (c.default || '');
                    control.addEventListener('input', emit); control.addEventListener('change', emit);
                    row.appendChild(control);
                });
                var rm = h('button', 'btn btn--sm btn--icon btn--ghost'); rm.type = 'button'; rm.title = 'Remove'; rm.setAttribute('aria-label', 'Remove'); rm.innerHTML = __ui.icon('x');
                rm.addEventListener('click', function () { row.remove(); toggleHead(); emit(); });
                row.appendChild(rm); list.appendChild(row); toggleHead();
            }
            function toggleHead() { head.hidden = !list.children.length; }
            add.addEventListener('click', function () { addRow({}); emit(); var last = list.lastChild; if (last) last.querySelector('input,select').focus(); });
            wrap.appendChild(head); wrap.appendChild(list); wrap.appendChild(add); toggleHead();
            return {
                node: wrap,
                get: function () { return [].map.call(list.children, function (row) { var o = {}; row.querySelectorAll('[data-key]').forEach(function (c) { o[c.dataset.key] = c.value; }); return o; }); },
                set: function (v) { list.textContent = ''; (v || []).forEach(addRow); toggleHead(); },
                focus: function () { add.focus(); }
            };
        }
    };

    function buildForm(spec, hooks) {
        var state = { values: Object.assign({}, spec.values), controls: {}, rows: {}, errors: {} };
        var root = h('div', 'pr');
        var head = h('div', 'pr-head');
        var iconBox = h('span', 'pr-icon'), titles = h('div'), titleEl = h('div', 'pr-title'), subEl = h('div', 'pr-sub selectable');
        function setIcon(i) {
            iconBox.textContent = '';
            if (i && i.src) { var im = h('img'); im.alt = ''; im.src = i.src; iconBox.appendChild(im); } else if (i) iconBox.innerHTML = __ui.icon(i); else iconBox.hidden = true;
        }
        setIcon(spec.icon);
        titleEl.textContent = spec.title || ''; subEl.textContent = spec.subtitle || ''; subEl.hidden = !spec.subtitle;
        titles.appendChild(titleEl); titles.appendChild(subEl); head.appendChild(iconBox); head.appendChild(titles);
        root.appendChild(head);

        var tabs = spec.tabs || [], tabBar = h('div', 'pr-tabs'), body = h('div', 'pr-body'), panes = {};
        tabBar.setAttribute('role', 'tablist');
        tabBar.hidden = tabs.length < 2;
        tabs.forEach(function (tab, idx) {
            var tb = h('button', 'pr-tab', tab.label); tb.type = 'button'; tb.setAttribute('role', 'tab'); tb.dataset.tab = tab.id;
            tb.addEventListener('click', function () { select(tab.id); });
            tabBar.appendChild(tb);
            var pane = h('div', 'pr-pane'); pane.setAttribute('role', 'tabpanel'); pane.dataset.tab = tab.id; panes[tab.id] = pane; body.appendChild(pane);
            tab.fields.forEach(function (f) { buildField(f, pane, tab.id); });
        });
        function select(id) {
            tabBar.querySelectorAll('.pr-tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
            Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== id; });
            state.tab = id;
        }
        select(tabs.length ? tabs[0].id : '');

        function buildField(f, pane, tabId) {
            if (f.type === 'group') { var g = h('div', 'pr-group', f.text); pane.appendChild(g); state.rows[uid()] = { f: f, node: g }; return; }
            if (f.type === 'note') { var n = h('div', 'pr-note' + (f.warn ? ' is-warn' : ''), f.text); pane.appendChild(n); state.rows[uid()] = { f: f, node: n }; return; }
            var id = uid(), row = h('div', 'pr-field'), label = h('label', 'pr-label', f.label || ''), ctl = h('div', 'pr-control');
            label.htmlFor = id; row.appendChild(label); row.appendChild(ctl);
            var control;
            if (f.type === 'info') {
                var info = h('div', 'pr-info selectable'); ctl.appendChild(info);
                control = { node: info, get: function () { return info.textContent; }, set: function (v) { info.textContent = v == null ? '' : v; }, focus: function () {} };
            } else {
                var make = CONTROLS[f.type || 'text'];
                control = make(f, function () { onEdit(f.key); }, id);
                if (spec.readonly || f.disabled) {
                    if (control.node.querySelectorAll) control.node.querySelectorAll('input,select,textarea,button').forEach(function (x) { x.disabled = true; });
                    control.node.disabled = true;
                }
                ctl.appendChild(control.node);
            }
            if (f.help) ctl.appendChild(h('div', 'pr-help', f.help));
            var err = h('div', 'pr-error'); err.setAttribute('role', 'alert'); ctl.appendChild(err);
            if (f.type === 'rows' || f.type === 'swatches') label.removeAttribute('for');
            control.set(f.type === 'info' && f.value !== undefined ? f.value : state.values[f.key]);
            pane.appendChild(row);
            state.controls[f.key || id] = control;
            state.rows[f.key || id] = { f: f, node: row, err: err, tab: tabId };
        }

        function values() {
            var out = Object.assign({}, state.values);
            Object.keys(state.controls).forEach(function (k) { var f = state.rows[k].f; if (f.type !== 'info') out[k] = state.controls[k].get(); });
            return out;
        }
        function refresh() {
            var v = values();
            Object.keys(state.rows).forEach(function (k) {
                var f = state.rows[k].f;
                state.rows[k].node.hidden = typeof f.showIf === 'function' ? !f.showIf(v) : false;
            });
        }
        function setError(key, msg) {
            var r = state.rows[key]; if (!r || !r.err) return;
            r.err.textContent = msg || ''; r.node.classList.toggle('has-error', !!msg);
            if (msg) { if (r.tab && r.tab !== state.tab) select(r.tab); state.controls[key].focus(); }
        }
        function validate() {
            var v = values(), first = null;
            Object.keys(state.rows).forEach(function (k) {
                var r = state.rows[k], f = r.f; if (!r.err) return;
                r.err.textContent = ''; r.node.classList.remove('has-error');
                if (r.node.hidden || f.type === 'info') return;
                var val = v[k], msg = '';
                if (f.required && (val === '' || val == null)) msg = 'Required.';
                else if (f.validate) msg = f.validate(val, v) || '';
                if (msg) { r.err.textContent = msg; r.node.classList.add('has-error'); first = first || k; }
            });
            if (first) { var r = state.rows[first]; if (r.tab !== state.tab) select(r.tab); state.controls[first].focus(); }
            return !first;
        }
        function onEdit(key) { refresh(); hooks.edited(key); }

        root.appendChild(tabBar); root.appendChild(body);
        var banner = h('div', 'pr-banner'); banner.setAttribute('role', 'alert'); root.appendChild(banner);
        refresh();
        return {
            root: root, values: values, validate: validate, setError: setError, refresh: refresh, select: select,
            setValue: function (k, v) { if (state.controls[k]) state.controls[k].set(v); state.values[k] = v; refresh(); },
            setBanner: function (t) { banner.textContent = t || ''; },
            setTitle: function (t, sub) { titleEl.textContent = t; if (sub !== undefined) { subEl.textContent = sub; subEl.hidden = !sub; } },
            setIcon: setIcon, controls: state.controls, rows: state.rows
        };
    }

    function open(spec) {
        if (spec.id && openWindows[spec.id]) { openWindows[spec.id].focus(); return openWindows[spec.id]; }
        var dirty = false, applied = false, api, shell = null, form;
        var foot = h('div', 'pr-foot'), left = h('div', 'pr-actions'), spacer = h('div', 'grow');
        left.style.display = 'flex'; left.style.gap = '6px'; left.style.flexWrap = 'wrap';
        var okBtn = h('button', 'btn btn--primary', spec.applyLabel || 'OK'), cancelBtn = h('button', 'btn', spec.readonly ? 'Close' : 'Cancel'), applyBtn = h('button', 'btn', 'Apply');
        [okBtn, cancelBtn, applyBtn].forEach(function (b) { b.type = 'button'; });
        applyBtn.disabled = true;

        form = buildForm(spec, { edited: function (key) { dirty = true; applyBtn.disabled = false; form.setBanner(''); if (spec.onChange) spec.onChange(form.values(), key, api); } });

        (spec.actions || []).forEach(function (a) {
            var b = h('button', 'btn btn--sm'); b.type = 'button'; b.innerHTML = (a.icon ? __ui.icon(a.icon) : '') + '<span></span>'; b.lastChild.textContent = a.label;
            b.addEventListener('click', function (ev) {
                if (a.menu) { var r = b.getBoundingClientRect(); Promise.resolve(a.menu(api)).then(function (items) { __ui.menu(items.filter(Boolean), r.left, r.bottom + 2); }); }
                else if (a.onClick) a.onClick(api, ev);
            });
            left.appendChild(b);
        });
        foot.appendChild(left); foot.appendChild(spacer);
        if (!spec.readonly) { foot.appendChild(okBtn); foot.appendChild(cancelBtn); foot.appendChild(applyBtn); } else foot.appendChild(cancelBtn);
        form.root.appendChild(foot);

        function apply() {
            if (!form.validate()) return Promise.resolve(false);
            form.setBanner('');
            okBtn.disabled = applyBtn.disabled = true;
            return Promise.resolve().then(function () { return spec.onApply ? spec.onApply(form.values(), api) : undefined; }).then(function () {
                dirty = false; applied = true; okBtn.disabled = false; applyBtn.disabled = true; return true;
            }, function (err) {
                okBtn.disabled = false; applyBtn.disabled = false;
                if (err && err.field && form.rows[err.field]) form.setError(err.field, __ui.errorText(err)); else form.setBanner(__ui.errorText(err));
                return false;
            });
        }
        function finish() {
            if (spec.id) delete openWindows[spec.id];
            if (spec.onClose) try { spec.onClose(applied); } catch (e) { console.error(e); }
        }
        function askDiscard() {
            if (!dirty) return Promise.resolve(true);
            return __ui.confirm({ title: 'Discard changes?', message: 'You changed something that was not applied.', confirmText: 'Discard', cancelText: 'Keep editing', danger: true });
        }

        okBtn.addEventListener('click', function () { apply().then(function (ok) { if (ok) api.close(true); }); });
        applyBtn.addEventListener('click', apply);
        cancelBtn.addEventListener('click', function () { api.close(); });
        form.root.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT' && e.target.type !== 'button' && !spec.readonly) { e.preventDefault(); okBtn.click(); }
            else if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); api.close(); }
        });

        var wm = window.__window && document.getElementById('wm');
        if (wm) {
            shell = __window.new(spec.title || 'Properties', spec.size || [520, 540], wm, finish, 0, { appId: 'properties', icon: typeof spec.icon === 'string' ? spec.icon : 'settings', minSize: spec.minSize || [360, 300], rememberSize: false, explicitSize: true });
            shell.getBody().appendChild(form.root);
            shell.beforeClose = askDiscard;
            api = {
                focus: function () { shell.focus(); },
                close: function (force) { return shell.close(!!force); },
                setTitle: function (t, sub) { form.setTitle(t, sub); shell.setTitle(t); }
            };
        } else {
            var closed = false, closeDialog = null;
            api = {
                setTitle: form.setTitle, focus: function () {},
                close: function (force) {
                    return (force ? Promise.resolve(true) : askDiscard()).then(function (ok) { if (ok && closeDialog) closeDialog(null); return ok; });
                }
            };
            __ui.dialog({ title: '', body: form.root, wide: true, actions: [], onOpen: function (box, done) {
                closeDialog = done;
                box.style.width = 'min(560px, calc(100vw - 24px))'; box.style.padding = '0';
                var title = box.querySelector('h3'); if (title) title.remove();
            } }).then(function () { if (!closed) { closed = true; finish(); } });
        }
        Object.assign(api, {
            getValues: form.values, setValue: form.setValue, setValues: function (o) { Object.keys(o).forEach(function (k) { form.setValue(k, o[k]); }); },
            setBanner: form.setBanner, setError: form.setError, markClean: function () { dirty = false; applyBtn.disabled = true; }, rebuild: form.refresh,
            setIcon: form.setIcon, isDirty: function () { return dirty; }
        });
        if (spec.id) openWindows[spec.id] = api;
        var first = form.root.querySelector('.pr-pane:not([hidden]) input:not([disabled]), .pr-pane:not([hidden]) select:not([disabled])');
        if (first) setTimeout(function () { first.focus(); }, 30);
        return api;
    }

    function openFileInfo(entry, opts) {
        opts = opts || {};
        function fmtSize(n) { if (n == null) return ''; var u = ['B', 'KB', 'MB', 'GB'], i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
        function fmtDate(t) { return t ? new Date(t * 1000).toLocaleString() : ''; }
        var folder = entry.type === 'folder', slash = entry.path.lastIndexOf('/');
        var fields = [
            { type: 'info', label: 'Name', value: entry.name },
            { type: 'info', label: 'Location', value: slash <= 0 ? '/' : entry.path.slice(0, slash) },
            { type: 'info', label: 'Type', value: folder ? 'Folder' : (entry.ext ? entry.ext.toUpperCase() + ' file' : 'File') + (entry.executable ? ' (executable)' : '') }
        ];
        if (!folder) fields.push({ type: 'info', label: 'Size', value: fmtSize(entry.size) + (entry.size >= 1024 ? ' (' + entry.size.toLocaleString() + ' bytes)' : '') });
        if (entry.creation_date) fields.push({ type: 'info', label: 'Created', value: fmtDate(entry.creation_date) });
        if (entry.modification_date) fields.push({ type: 'info', label: 'Modified', value: fmtDate(entry.modification_date) });
        if (opts.fields) fields = fields.concat(opts.fields);
        return open({ id: 'file:' + entry.path, title: entry.name, subtitle: 'Properties', icon: folder ? 'folder' : 'file', size: [440, 360], minSize: [340, 240], readonly: true,
            tabs: [{ id: 'general', label: 'General', fields: fields }], actions: opts.actions });
    }

    return ({ open: open, openFileInfo: openFileInfo, spriteNames: sprite });
})();
