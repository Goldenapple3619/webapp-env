/**
 * The virtual desktop: shell, launcher, taskbar, start menu, image/video viewer.
 * The icons on the desktop are desktop/script/icons.js; the look is lib/ltheme.js; shortcuts are lib/lshortcut.js.
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
        var wm = $('wm');
        var user = auth.getUser() || { username: '?' };
        var entries = {};            // appId -> [{ win, inst, sid }]
        var registryList = [];

        $('start-user').textContent = user.username;
        $('start-avatar').textContent = user.username.charAt(0).toUpperCase();

        // ONE gateway session serves everything the desktop persists: its icons, shortcuts, layout and appearance
        var desktopHandle = ws.app('desktop');
        __shortcuts.setHandle(desktopHandle);
        __theme.configure({ fileUrl: function (p) { return auth.fileUrl(p); }, handle: function () { return desktopHandle; } });

        // ================================================================= launcher
        function openViewer(args, opts) {
            var path = args.path || '';
            var name = path.split('/').pop();
            var kind = /\.(mp4|webm|ogv)$/i.test(path) ? 'video' : /\.pdf$/i.test(path) ? 'pdf' : 'image';
            var win = __window.new(name, [720, 520], wm, null, 30, { icon: kind === 'video' ? 'file' : 'image', appId: 'viewer', minSize: [320, 240], maximized: opts && opts.maximized });
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
                el.alt = name; el.title = 'Click to toggle actual size'; el.style.cursor = 'zoom-in'; el.draggable = false;
                el.addEventListener('click', function () {
                    var full = el.style.maxWidth === 'none';
                    el.style.maxWidth = full ? '100%' : 'none'; el.style.maxHeight = full ? '100%' : 'none';
                    body.style.display = full ? 'grid' : 'block'; el.style.cursor = full ? 'zoom-in' : 'zoom-out';
                });
            }
            body.appendChild(el);
        }

        /** opts: { width, height, maximized } - from a shortcut's <window> */
        function launch(app, args, opts) {
            args = args || {}; opts = opts || {};
            if (app.builtin) { openViewer(args, opts); return Promise.resolve(); }

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
                var size = [opts.width || app.size[0], opts.height || app.size[1]];
                var win = __window.new(app.title, size, wm, function () {
                    entries[app.id] = (entries[app.id] || []).filter(function (e) { return e !== entry; });
                    try { if (entry.inst && entry.inst.nonStandaloneDestroy) entry.inst.nonStandaloneDestroy(); } catch (e) { console.error(e); }
                    if (entry.sid) ws.closeApp(entry.sid);
                }, 30, { icon: app.icon, appId: app.id, minSize: app.minSize, maximized: !!opts.maximized, explicitSize: !!(opts.width || opts.height) });
                entry.win = win;
                win.beforeClose = function () { return entry.inst && entry.inst.canClose ? entry.inst.canClose() : true; };
                list.push(entry);
                var host = {
                    setTitle: function (t) { win.setTitle(t ? t + ' - ' + app.name : app.title); },
                    close: function () { win.close(); },
                    focus: function () { win.focus(); },
                    launch: function (id, a, o) { return apps.open(id, a, o); },
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

        // ================================================================= start menu
        var startMenu = $('start-menu'), startButton = $('start-button');
        function toggleStart(force) {
            var open = force !== undefined ? force : !startMenu.classList.contains('is-open');
            startMenu.classList.toggle('is-open', open);
            startButton.setAttribute('aria-expanded', String(open));
        }
        startButton.addEventListener('click', function (e) { e.stopPropagation(); toggleStart(); });
        document.addEventListener('pointerdown', function (e) {
            if (!startMenu.contains(e.target) && !startButton.contains(e.target)) toggleStart(false);
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleStart(false); });
        // clicks inside an app's <iframe> never reach the document: closing the menu when the window loses focus covers that
        window.addEventListener('blur', function () { toggleStart(false); });

        $('start-personalize').addEventListener('click', function () { toggleStart(false); document.desktopState.openAppearance(); });
        $('start-settings').addEventListener('click', function () { toggleStart(false); document.desktopState.openSettings(); });
        $('start-logout').addEventListener('click', function () {
            toggleStart(false);
            ws.close();
            __theme.forgetCache();   // the next person on this browser must not briefly see this user's look on the sign-in page
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
                b.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    __ui.menu([
                        { label: w.isMinimized() ? 'Restore' : 'Minimize', icon: w.isMinimized() ? 'restore' : 'minus', action: function () { w.isMinimized() ? w.focus() : w.minimize(); } },
                        { label: w.isMaximized() ? 'Restore size' : 'Maximize', icon: w.isMaximized() ? 'restore' : 'maximize', action: function () { w.focus(); w.toggleMaximize(); } },
                        { separator: true },
                        { label: 'Close', icon: 'x', danger: true, action: function () { w.close(); } }
                    ], e.clientX, e.clientY - 120);
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

        // clock (only touches the DOM when the minute changes); the 12/24 h choice comes from Appearance
        var tf, df = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), lastClock = '', hourMode = null;
        function clockFormat() {
            var m = ((__theme.current().taskbar || {}).hour12) || 'auto';
            if (m === hourMode && tf) return;
            hourMode = m; lastClock = '';
            tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: m === 'auto' ? undefined : m === '12' });
        }
        function tick() {
            clockFormat();
            var now = new Date(), t = tf.format(now);
            if (t === lastClock) return;
            lastClock = t;
            $('clock-time').textContent = t;
            $('clock-date').textContent = df.format(now);
        }
        tick();
        setInterval(tick, 1000);
        __theme.onChange(tick);

        // connection indicator
        var tray = $('tray-status');
        ws.onStatus(function (s) {
            tray.dataset.state = s.state;
            $('tray-latency').textContent = s.state === 'open' ? (s.latency != null ? s.latency + ' ms' : 'online') : s.state === 'connecting' ? '…' : 'offline';
            tray.title = 'Apps gateway: ' + s.state + (s.latency != null && s.state === 'open' ? ' (' + s.latency + ' ms)' : '');
        });
        tray.addEventListener('click', function () { document.desktopState.openSettings('connection'); });

        // ================================================================= registry, look, icons
        apps.list().then(function (list) {
            registryList = list;
            var visible = list.filter(function (a) { return !a.hidden; });
            $('start-apps').innerHTML = visible.map(function (a) {
                return '<button class="app-shortcut-start-menu" data-app="' + esc(a.id) + '" type="button">' + icon(a.icon) + '<span>' + esc(a.name) + '</span></button>';
            }).join('');
            $('start-apps').addEventListener('click', function (e) {
                var b = e.target.closest('[data-app]');
                if (b) { toggleStart(false); apps.open(b.dataset.app); }
            });
            __theme.configure({ registry: list });
            return desktopHandle;
        }).then(function (h) {
            __theme.load().catch(function (e) { console.error('appearance', e); });
            var icons = document.desktopState.createIcons({ surface: $('de-icons'), handle: h, apps: apps, registry: function () { return registryList; } });
            document.desktopState.icons = icons;
            return icons.refresh();
        }).catch(function (e) { console.error(e); __ui.toast('The desktop could not load its icons.', 'error'); });

        // a file opened from outside the page (e.g. /desktop/?args={"app":"code","path":"/a.txt"})
        var initial = apps.initialArgs();
        if (initial.app) apps.open(initial.app, initial);
    };
})();
