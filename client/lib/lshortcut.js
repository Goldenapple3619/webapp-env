var __shortcuts = (() => {
    var handleP = null, newSeq = 0;
    function handle() {
        if (!handleP) handleP = document.wsscon.app('desktop');
        return handleP;
    }
    function apps() { return __apps.getInstance(); }
    function tabId() { return (window.__theme && __theme.tabId) || ''; }


    function coerce(arg) {
        if (arg.type === 'number') { var n = Number(arg.value); return isFinite(n) ? n : arg.value; }
        if (arg.type === 'boolean') return String(arg.value).toLowerCase() === 'true';
        return arg.value;
    }

    function argsObject(list) {
        var out = {};
        (list || []).forEach(function (a) {
            var v = coerce(a);
            if (Object.prototype.hasOwnProperty.call(out, a.name)) out[a.name] = [].concat(out[a.name], [v]);
            else out[a.name] = v;
        });
        return out;
    }

    function targetKey(appId) { return appId === 'music' ? 'play' : 'path'; }

    function plan(s) {
        var win = {};
        if (s.window) {
            if (s.window.width) win.width = s.window.width;
            if (s.window.height) win.height = s.window.height;
            if (s.window.maximized) win.maximized = true;
        }
        if (!s.open) return { associate: s.target, win: win };
        var args = argsObject(s.args);
        if (s.target && args[targetKey(s.open)] === undefined) args[targetKey(s.open)] = s.target;
        return { appId: s.open, args: args, win: win };
    }

    function iconOf(s, list) {
        if (s.icon && s.icon.charAt(0) === '/') return { src: window.auth ? auth.fileUrl(s.icon) : s.icon };
        if (s.icon) return { name: s.icon };
        var app = (list || []).filter(function (a) { return a.id === s.open; })[0];
        return { name: app ? app.icon : (s.target ? 'file' : 'file') };
    }

    function defaults(list) {
        return list.filter(function (a) { return !a.hidden; }).map(function (a) { return { name: a.name, icon: a.icon, open: a.id }; });
    }

    function read(path) { return handle().then(function (h) { return h.fetch('shortcut', { path: path }); }); }

    function launch(s) {
        var p = plan(s), a = apps();
        if (p.associate) {
            return handle().then(function (h) { return h.fetch('stat', { path: p.associate }); }).then(function (r) {
                return a.openPath(p.associate, r.stat.type);
            });
        }
        return a.find(p.appId).then(function (app) {
            if (!app) throw { code: 'unknown_app', details: { detail: 'This shortcut starts “' + p.appId + '”, which is not installed.' } };
            return a.open(p.appId, p.args, p.win);
        });
    }
    function run(path) {
        return read(path).then(function (r) {
            if (r.error) throw { code: r.error, details: { detail: r.detail } };
            return launch(r.shortcut);
        });
    }

    var ARG_TYPES = [{ value: 'string', label: 'text' }, { value: 'number', label: 'number' }, { value: 'boolean', label: 'true/false' }];

    function fromValues(v) {
        var win = {};
        if (v.width) win.width = v.width;
        if (v.height) win.height = v.height;
        if (v.maximized) win.maximized = true;
        return {
            name: (v.name || '').trim(), comment: (v.comment || '').trim(), open: v.open || '', target: (v.target || '').trim(), icon: v.icon || '',
            args: (v.args || []).filter(function (r) { return (r.name || '').trim(); }).map(function (r) { return { name: r.name.trim(), type: r.type || 'string', value: r.value || '' }; }),
            window: win
        };
    }
    function toValues(s) {
        s = s || { name: '', icon: '', open: '', target: '', comment: '', args: [], window: {} };
        return { name: s.name, comment: s.comment || '', open: s.open || '', target: s.target || '', icon: s.icon || '',
            args: (s.args || []).map(function (a) { return { name: a.name, type: a.type || 'string', value: a.value }; }),
            width: (s.window || {}).width || null, height: (s.window || {}).height || null, maximized: !!(s.window || {}).maximized };
    }

    function spec(list, o) {
        var appOptions = [{ value: '', label: '(open the target with its default application)' }].concat(
            list.filter(function (a) { return !a.hidden; }).map(function (a) { return { value: a.id, label: a.name + ' (' + a.id + ')' }; }));
        var known = {}, notes = [];
        list.forEach(function (a) {
            (a.args || []).forEach(function (x) { known[x.name] = true; });
            if (a.args && a.args.length) notes.push({ type: 'note', showIf: function (v) { return v.open === a.id; },
                text: a.name + ' understands: ' + a.args.map(function (x) { return x.name + ' – ' + x.help; }).join('; ') + '.' });
        });
        var general = [
            { key: 'name', label: 'Name', type: 'text', required: true, maxlength: 80 },
            { key: 'comment', label: 'Description', type: 'text', maxlength: 300, help: 'Shown nowhere yet except here and in the XML; handy for you.' },
            { type: 'group', text: 'What it starts' },
            { key: 'open', label: 'Application', type: 'select', options: appOptions },
            { key: 'target', label: 'Target', type: 'path', pick: 'file', help: 'A file or folder. With an application it is passed as its path (or as the song to play for Music); without one, the file’s default application opens it.',
              validate: function (v, all) { return v && v.charAt(0) !== '/' ? 'Use an absolute path like /documents/notes.txt' : (!v && !all.open ? 'Choose an application or a target.' : ''); } },
            { key: 'icon', label: 'Icon', type: 'icon' }
        ];
        var file = o.path ? [{ type: 'group', text: 'The file' }, { type: 'info', label: 'Stored as', value: o.path }] : [];
        var tabs = [
            { id: 'general', label: 'Shortcut', fields: general.concat(file) },
            { id: 'args', label: 'Arguments', fields: [
                { type: 'note', text: 'Extra data handed to the application when it starts. Leave empty for the usual behaviour.' }].concat(notes, [
                { key: 'args', label: 'Arguments', type: 'rows', addLabel: 'Add argument', max: 32,
                  columns: [{ key: 'name', label: 'Name', placeholder: 'name', suggest: Object.keys(known), width: '1.2fr' },
                            { key: 'type', label: 'Type', type: 'select', options: ARG_TYPES, width: '.9fr' },
                            { key: 'value', label: 'Value', placeholder: 'value', width: '1.8fr' }] }]) },
            { id: 'window', label: 'Window', fields: [
                { type: 'note', text: 'How the window opens. Empty = the application’s usual size.' },
                { key: 'width', label: 'Width', type: 'number', min: 160, max: 10000, unit: 'px' },
                { key: 'height', label: 'Height', type: 'number', min: 160, max: 10000, unit: 'px' },
                { key: 'maximized', label: 'Maximized', type: 'checkbox', text: 'Open maximized' }] }
        ];
        if (o.warnings && o.warnings.length) tabs[0].fields.unshift({ type: 'note', warn: true, text: o.warnings.join(' ') });
        return tabs;
    }

    function openEditor(o) {
        return apps().list().then(function (list) {
            var current = o.shortcut, mtime = o.mtime, path = o.path;
            var s = toValues(current);
            var actions = [];
            if (path) {
                actions.push({ label: 'Open in Code', icon: 'code', onClick: function () { apps().open('code', { path: path }); } });
                actions.push({ label: 'Open with…', icon: 'external', menu: function () {
                    return list.filter(function (a) { return !a.hidden && !a.builtin; }).map(function (a) { return { label: a.name, icon: a.icon, action: function () { apps().open(a.id, a.id === 'music' ? { play: path } : { path: path }); } }; });
                } });
            }
            actions.push({ label: 'Test', icon: 'play', onClick: function (api) {
                var v = api.getValues();
                if (!(v.open || v.target)) { api.setBanner('Choose an application or a target first.'); return; }
                launch(fromValues(v)).catch(function (err) { api.setBanner(__ui.errorText(err)); });
            } });
            var title = o.create ? 'New shortcut' : (current ? current.name : path.split('/').pop());
            return __props.open({
                id: o.id, title: title, subtitle: path || o.create.dir, icon: iconOf(current || {}, list), size: [540, 580], minSize: [380, 340],
                tabs: spec(list, { path: path, warnings: o.warnings }), values: s, actions: actions, applyLabel: 'OK',
                onChange: function (v, key, api) {
                    if (key === 'name' || key === 'open' || key === 'icon') { var ic = iconOf(fromValues(v), list); api.setIcon(ic.src ? { src: ic.src } : ic.name); }
                },
                onApply: function (v, api) {
                    var data = fromValues(v);
                    var save = o.create
                        ? handle().then(function (h) { return h.update('shortcut_create', { dir: o.create.dir, shortcut: data, origin: tabId() }); })
                        : handle().then(function (h) { return h.update('shortcut_save', { path: path, shortcut: data, base_mtime: mtime, origin: tabId() }); });
                    return save.then(function (r) {
                        if (o.create) { path = r.path; o.create = null; api.setTitle(data.name, path); }
                        else { mtime = r.mtime; api.setTitle(data.name, path); }
                        if (o.onSaved) o.onSaved(path, r.shortcut);
                    }, function (err) {
                        if (err && err.code === 'conflict' && !o.create) {
                            return __ui.confirm({ title: 'The file changed', message: 'This shortcut was changed somewhere else since you opened it. Overwrite it with your version?', confirmText: 'Overwrite', danger: true }).then(function (yes) {
                                if (!yes) throw { code: 'conflict', details: { detail: 'Not saved: the file was changed elsewhere.' } };
                                return handle().then(function (h) { return h.update('shortcut_save', { path: path, shortcut: data, force: true, origin: tabId() }); }).then(function (r) { mtime = r.mtime; });
                            });
                        }
                        throw err;
                    });
                }
            });
        });
    }

    function openProperties(path, extra) {
        return read(path).then(function (r) {
            if (r.error) {
                return __props.open({ id: 'shortcut:' + path, title: path.split('/').pop(), subtitle: path, icon: 'alert', size: [480, 280], minSize: [360, 220], readonly: true,
                    tabs: [{ id: 'g', label: 'Shortcut', fields: [{ type: 'note', warn: true, text: 'This shortcut cannot be read: ' + __ui.errorText({ code: r.error, details: { detail: r.detail } }) + ' You can fix it by hand in the Code editor.' },
                        { type: 'info', label: 'File', value: path }] }],
                    actions: [{ label: 'Open in Code', icon: 'code', onClick: function () { apps().open('code', { path: path }); } }] });
            }
            return openEditor(Object.assign({ id: 'shortcut:' + path, path: path, shortcut: r.shortcut, warnings: r.warnings, mtime: r.mtime }, extra || {}));
        });
    }
    function openCreate(dir, extra) {
        return openEditor(Object.assign({ id: 'shortcut:new:' + (++newSeq), create: { dir: dir || '/desktop' } }, extra || {}));
    }

    return ({
        setHandle: function (p) { handleP = p; },
        coerce: coerce, argsObject: argsObject, plan: plan, targetKey: targetKey, iconOf: iconOf, defaults: defaults,
        fromValues: fromValues, toValues: toValues,
        read: read, launch: launch, run: run, openProperties: openProperties, openCreate: openCreate
    });
})();
if (typeof module !== 'undefined') module.exports = __shortcuts;
