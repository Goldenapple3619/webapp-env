var __apps = (() => {
    var instance = null;

    function init() {
        var registry = null, launcher = null;

        function load() {
            if (registry) return registry;
            registry = __lloader.getInstance().loadJSON('/apps/registry.json').then(function (r) { return r.content.apps; });
            return registry;
        }
        function find(id) { return load().then(function (list) { return list.filter(function (a) { return a.id === id; })[0] || null; }); }

        function ext(path) { var m = /\.([^./]+)$/.exec(path || ''); return m ? m[1].toLowerCase() : ''; }

        function associate(path, type) {
            return load().then(function (list) {
                if (type === 'folder') return list.filter(function (a) { return a.handles && a.handles.folder; })[0];
                var e = ext(path);
                var byExt = list.filter(function (a) { return a.handles && a.handles.ext && a.handles.ext.indexOf(e) >= 0; })[0];
                return byExt || list.filter(function (a) { return a.handles && a.handles.fallback; })[0];
            });
        }

        function initialArgs() {
            try { return JSON.parse(new URLSearchParams(location.search).get('args') || '{}'); } catch (e) { return {}; }
        }

        function open(id, args, opts) {
            args = args || {};
            return find(id).then(function (app) {
                if (!app) throw new Error('unknown app ' + id);
                if (launcher) return launcher(app, args, opts || {});
                if (app.builtin) {
                    if (args.path) window.open(__auth.getInstance().fileUrl(args.path), '_blank', 'noopener');
                    return null;
                }
                if (window.nativeShell && window.nativeShell.openApp) return window.nativeShell.openApp(app.id, args);
                var url = app.dir + (Object.keys(args).length ? '?args=' + encodeURIComponent(JSON.stringify(args)) : '');
                window.open(url, '_blank', 'noopener');
            });
        }

        function openPath(path, type) {
            if (type !== 'folder' && ext(path) === 'shc' && window.__shortcuts) return __shortcuts.run(path);   // a shortcut file runs
            return associate(path, type).then(function (app) {
                if (!app) return null;
                var args = app.id === 'music' ? { play: path } : { path: path };
                return open(app.id, args);
            });
        }

        return ({
            load: load, find: find, ext: ext, associate: associate, open: open, openPath: openPath, initialArgs: initialArgs,
            list: function () { return load(); },
            setLauncher: function (fn) { launcher = fn; },
            hasLauncher: function () { return !!launcher; }
        });
    }

    return ({
        getInstance: function () {
            if (instance === null) instance = init();
            return instance;
        }
    });
})();
