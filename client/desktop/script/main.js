/**
 * The virtual desktop: shell, launcher, taskbar, start menu, desktop icons, image/video viewer.
 * Apps are NOT downloaded up front: their manifest is loaded the first time they are opened.
 */
(function () {
    var auth = __auth.getInstance();
    var apps = __apps.getInstance();
    var $ = function (id) { return document.getElementById(id); };
    var icon = __ui.icon, esc = __ui.esc;

    document.setupApp = document.setupApp || {};
    document.desktopState = document.desktopState || {};

    document.onloaded = function () {
        var root = document.getElementById('app');
        document.app.build('/desktop/UI/main.html', root);
        document.title = 'Desktop';

        var ws = document.wsscon;
        var wm = $('wm'), area = $('de-area');
        var user = auth.getUser() || { username: '?' };
        var entries = {};            // appId -> [{ win, inst }]
        var registryList = [];

        $('start-user').textContent = user.username;
        $('start-avatar').textContent = user.username.charAt(0).toUpperCase();

        // ================================================================= launcher
        function openViewer(args) {
            var path = args.path || '';
            var name = path.split('/').pop();
            var kind = /\.(mp4|webm|ogv)$/i.test(path) ? 'video' : /\.pdf$/i.test(path) ? 'pdf' : 'image';
            var win = __window.new(name, [720, 520], wm, null, 30, { icon: kind === 'video' ? 'file' : 'image' });
            var body = win.getBody();
            var src = auth.fileUrl(path);
            body.style.display = 'grid';
            body.style.placeItems = 'center';
            body.style.background = kind === 'image' ? '#2a2140' : '#000';
            if (kind === 'pdf') { body.style.display = 'block'; win.setIframe(src); return; }
            var el = document.createElement(kind === 'video' ? 'video' : 'img');
            el.src = src;
            el.style.maxWidth = '100%'; el.style.maxHeight = '100%';
            if (kind === 'video') { el.controls = true; el.autoplay = true; el.style.width = '100%'; el.style.height = '100%'; }
            else {
                el.alt = name; el.title = 'Click to toggle actual size'; el.style.cursor = 'zoom-in';
                el.addEventListener('click', function () {
                    var full = el.style.maxWidth === 'none';
                    el.style.maxWidth = full ? '100%' : 'none'; el.style.maxHeight = full ? '100%' : 'none';
                    body.style.display = full ? 'grid' : 'block'; el.style.cursor = full ? 'zoom-in' : 'zoom-out';
                });
            }
            body.appendChild(el);
        }

        function launch(app, args) {
            args = args || {};
            if (app.builtin) { openViewer(args); return Promise.resolve(); }

            var list = entries[app.id] = entries[app.id] || [];
            if (app.singleton && list.length) {
                var existing = list[0];
                existing.win.focus();
                if (existing.inst && existing.inst.handleIntent) existing.inst.handleIntent(args);
                return Promise.resolve();
            }
            var slow = setTimeout(function () { __ui.toast('Loading ' + app.name + '…'); }, 600);
            return document.app.loadApp(app.dir + 'index.json').then(function () {
                clearTimeout(slow);
                var entry = { win: null, inst: null, sid: null };
                var win = __window.new(app.title, app.size, wm, function () {
                    entries[app.id] = (entries[app.id] || []).filter(function (e) { return e !== entry; });
                    try { if (entry.inst && entry.inst.nonStandaloneDestroy) entry.inst.nonStandaloneDestroy(); } catch (e) { console.error(e); }
                    if (entry.sid) ws.closeApp(entry.sid);
                }, 30, { icon: app.icon, appId: app.id });
                entry.win = win;
                win.beforeClose = function () { return entry.inst && entry.inst.canClose ? entry.inst.canClose() : true; };
                list.push(entry);
                var host = {
                    setTitle: function (t) { win.setTitle(t ? t + ' - ' + app.name : app.title); },
                    close: function () { win.close(); },
                    focus: function () { win.focus(); },
                    launch: function (id, a) { return apps.open(id, a); },
                    isDesktop: true
                };
                try {
                    entry.inst = document.setupApp[app.setup](win.getBody(), false, undefined, function (sid) { entry.sid = sid; }, { args: args, host: host });
                } catch (e) {
                    console.error(e);
                    win.close();
                    __ui.toast('Could not start ' + app.name + '.', 'error');
                }
            }).catch(function (e) {
                clearTimeout(slow);
                console.error(e);
                __ui.toast('Could not load ' + app.name + '.', 'error');
            });
        }
        apps.setLauncher(launch);
        document.desktopState.launch = launch;

        // ================================================================= start menu + shortcuts
        var startMenu = $('start-menu'), startButton = $('start-button');
        function toggleStart(force) {
            var open = force !== undefined ? force : !startMenu.classList.contains('is-open');
            startMenu.classList.toggle('is-open', open);
            startButton.setAttribute('aria-expanded', String(open));
        }
        startButton.addEventListener('click', function (e) { e.stopPropagation(); toggleStart(); });
        document.addEventListener('pointerdown', function (e) {
            if (!startMenu.contains(e.target) && e.target !== startButton) toggleStart(false);
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleStart(false); });

        apps.list().then(function (list) {
            registryList = list.filter(function (a) { return !a.hidden; });
            $('start-apps').innerHTML = registryList.map(function (a) {
                return '<button class="app-shortcut-start-menu" data-app="' + esc(a.id) + '" type="button">' + icon(a.icon) + '<span>' + esc(a.name) + '</span></button>';
            }).join('');
            $('start-apps').addEventListener('click', function (e) {
                var b = e.target.closest('[data-app]');
                if (b) { toggleStart(false); apps.open(b.dataset.app); }
            });
            renderIcons();
        });

        $('start-settings').addEventListener('click', function () { toggleStart(false); document.desktopState.openSettings(); });
        $('start-logout').addEventListener('click', function () {
            toggleStart(false);
            ws.close();
            auth.logout().then(function () { location.replace('/connect/?reason=logout'); });
        });
        $('start-power').addEventListener('click', function () {
            toggleStart(false);
            // ask every window in turn; an unsaved editor can cancel the shutdown
            var chain = Promise.resolve(true);
            __window.list().forEach(function (w) { chain = chain.then(function (ok) { return ok ? w.close() : false; }); });
            chain.then(function (ok) {
                if (!ok) return __ui.toast('Shutdown cancelled.');
                ws.close();
                $('de-off').classList.add('is-on');
            });
        });
        $('power-on').addEventListener('click', function () { location.reload(); });

        // ================================================================= taskbar
        var tasks = $('tasks'), buttons = {};
        __window.onChange(function (type, w) {
            if (type === 'open') {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'task-btn';
                b.innerHTML = icon((w.meta && w.meta.icon) || 'file') + '<span></span>';
                b.querySelector('span').textContent = w.getTitle();
                b.title = w.getTitle();
                b.addEventListener('click', function () {
                    if (w.isMinimized()) w.focus();
                    else if (w.isFocused()) w.minimize();
                    else w.focus();
                });
                tasks.appendChild(b);
                buttons[w.id] = b;
                return;
            }
            var btn = buttons[w.id];
            if (!btn) return;
            if (type === 'close') { btn.remove(); delete buttons[w.id]; return; }
            if (type === 'title') { btn.querySelector('span').textContent = w.getTitle(); btn.title = w.getTitle(); }
            btn.classList.toggle('is-focused', w.isFocused() && !w.isMinimized());
            btn.classList.toggle('is-minimized', w.isMinimized());
        });

        // clock (only touches the DOM when the minute changes)
        var tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
        var df = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        var lastClock = '';
        function tick() {
            var now = new Date(), t = tf.format(now);
            if (t === lastClock) return;
            lastClock = t;
            $('clock-time').textContent = t;
            $('clock-date').textContent = df.format(now);
        }
        tick();
        setInterval(tick, 1000);

        // connection indicator
        var tray = $('tray-status');
        ws.onStatus(function (s) {
            tray.dataset.state = s.state;
            $('tray-latency').textContent = s.state === 'open' ? (s.latency != null ? s.latency + ' ms' : 'online') : s.state === 'connecting' ? '…' : 'offline';
            tray.title = 'Apps gateway: ' + s.state + (s.latency != null && s.state === 'open' ? ' (' + s.latency + ' ms)' : '');
        });
        tray.addEventListener('click', function () { document.desktopState.openSettings('connection'); });

        // ================================================================= desktop icons
        var iconsEl = $('de-icons'), desktopFiles = [], files = null;

        function iconFor(entry) {
            if (entry.kind === 'app') return '<div class="de-icon__img">' + icon(entry.icon) + '</div>';
            if (entry.type === 'folder') return '<div class="de-icon__img"><img src="/assets/images/default_folder.png" alt="" draggable="false"></div>';
            return '<div class="de-icon__img"><img src="/assets/images/default_file.png" alt="" draggable="false"></div>';
        }

        function renderIcons() {
            var items = registryList.map(function (a) { return { kind: 'app', id: a.id, name: a.name, icon: a.icon }; })
                .concat(desktopFiles.map(function (f) { return { kind: 'file', name: f.name, path: f.path, type: f.type }; }));
            iconsEl.innerHTML = items.map(function (it, i) {
                return '<button class="de-icon" role="listitem" data-i="' + i + '" type="button" title="' + esc(it.name) + '">' + iconFor(it) + '<span class="de-icon__name">' + esc(it.name) + '</span></button>';
            }).join('');
            iconsEl._items = items;
        }

        function openItem(it) {
            if (it.kind === 'app') apps.open(it.id);
            else apps.openPath(it.path, it.type);
        }

        iconsEl.addEventListener('click', function (e) {
            var b = e.target.closest('.de-icon');
            iconsEl.querySelectorAll('.is-selected').forEach(function (n) { n.classList.remove('is-selected'); });
            if (!b) return;
            b.classList.add('is-selected');
            if (e.pointerType === 'touch') openItem(iconsEl._items[b.dataset.i]);
        });
        iconsEl.addEventListener('dblclick', function (e) {
            var b = e.target.closest('.de-icon');
            if (b) openItem(iconsEl._items[b.dataset.i]);
        });
        iconsEl.addEventListener('keydown', function (e) {
            var b = e.target.closest('.de-icon');
            if (b && e.key === 'Enter') openItem(iconsEl._items[b.dataset.i]);
        });

        // rubber band selection
        var deskLib = __desktop.new();
        deskLib.setSelectionRect($('selectionRect'), $('de-surface'), function (r) {
            iconsEl.querySelectorAll('.de-icon').forEach(function (n) {
                if (!r) return;
                var b = n.getBoundingClientRect(), a = $('de-surface').getBoundingClientRect();
                var hit = !(b.right - a.left < r.left || b.left - a.left > r.left + r.width || b.bottom - a.top < r.top || b.top - a.top > r.top + r.height);
                n.classList.toggle('is-selected', hit);
            });
        });
        iconsEl.addEventListener('pointerdown', function (e) { if (e.target === iconsEl) { e.preventDefault(); } });
        $('de-surface').addEventListener('pointerdown', function (e) {
            if (e.target === $('de-surface') || e.target === iconsEl) iconsEl.querySelectorAll('.is-selected').forEach(function (n) { n.classList.remove('is-selected'); });
        });

        function refreshDesktopFiles() {
            if (!files) return;
            files.fetch('listdir', { path: '/desktop' }).then(function (r) {
                desktopFiles = r.content.filter(function (f) { return !f.hidden; });
                renderIcons();
            }).catch(function () { });
        }

        ws.app('explorer').then(function (h) {
            files = h;
            h.on('restore', refreshDesktopFiles);
            h.on('fs_changed', function (d) {
                var hit = d.dirs.indexOf('/desktop') >= 0 || d.files.some(function (f) { return f.indexOf('/desktop/') === 0; });
                if (hit) refreshDesktopFiles();
            });
            refreshDesktopFiles();
        }).catch(function () { });

        // context menus
        $('de-surface').addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var b = e.target.closest('.de-icon');
            var it = b && iconsEl._items[b.dataset.i];
            var make = function (kind) {
                return function () {
                    __ui.prompt({ title: kind === 'mkdir' ? 'New folder' : 'New file', label: 'Name', value: kind === 'mkdir' ? 'New folder' : 'New file.txt', selectBase: true }).then(function (name) {
                        if (name && files) files.update(kind, { path: '/desktop', name: name }).then(refreshDesktopFiles, function (err) { __ui.toast(__ui.errorText(err), 'error'); });
                    });
                };
            };
            if (it) {
                __ui.menu([
                    { label: 'Open', icon: 'arrow-right', action: function () { openItem(it); } },
                    it.kind === 'file' ? { label: 'Show in Explorer', icon: 'folder', action: function () { apps.open('explorer', { path: it.path }); } } : null,
                    it.kind === 'file' ? { separator: true } : null,
                    it.kind === 'file' ? { label: 'Delete', icon: 'trash', danger: true, action: function () {
                        __ui.confirm({ title: 'Delete', message: 'Delete "' + it.name + '"? This cannot be undone.', confirmText: 'Delete', danger: true }).then(function (ok) {
                            if (ok) files.update('delete', { paths: [it.path] }).then(refreshDesktopFiles, function (err) { __ui.toast(__ui.errorText(err), 'error'); });
                        });
                    } } : null
                ], e.clientX, e.clientY);
            } else {
                __ui.menu([
                    { label: 'New folder', icon: 'folder-plus', action: make('mkdir') },
                    { label: 'New file', icon: 'file-plus', action: make('mkfile') },
                    { separator: true },
                    { label: 'Open Desktop folder in Explorer', icon: 'folder', action: function () { apps.open('explorer', { path: '/desktop' }); } },
                    { label: 'Refresh', icon: 'refresh', action: refreshDesktopFiles }
                ], e.clientX, e.clientY);
            }
        });

        // Files dropped from the OS onto the desktop go to /desktop (same upload path as the Explorer)
        area.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
        area.addEventListener('drop', function (e) {
            if (!e.dataTransfer || !e.dataTransfer.files.length) return;
            e.preventDefault();
            Array.prototype.forEach.call(e.dataTransfer.files, function (f) {
                auth.upload('/desktop/' + f.name, f).then(function () { __ui.toast('Uploaded ' + f.name, 'ok'); }, function (err) { __ui.toast(f.name + ': ' + __ui.errorText(err), 'error'); });
            });
        });

        // a file opened from outside the page (e.g. /desktop/?args={"app":"code","path":"/a.txt"})
        var initial = apps.initialArgs();
        if (initial.app) apps.open(initial.app, initial);
    };
})();
