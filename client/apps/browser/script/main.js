(function () {
    var auth = __auth.getInstance();
    var apps = __apps.getInstance();
    var DIR = '/apps/browser/';

    document.setupApp = document.setupApp || {};
    document.setupApp.browser = function (parent, standalone, UIs, onConnect, options) {
        options = options || {};
        var host = options.host || { setTitle: function () { }, close: function () { }, launch: function (id, a) { return apps.open(id, a); } };
        var ws = document.wsscon;
        var ui = __ui;

        var rootEl = document.app.build(DIR + 'UI/main.html', parent);
        var $ = function (sel) { return rootEl.querySelector(sel); };
        var dom_main_area = $("#xp-main");
        var dom_search = $("#xp-path");

        var path = '';
        var reloadTimer = null;
        var handle = null;
        var destroyed = false;

        function toast(msg, kind) { ui.toast(msg, kind); }
        function fail(err) { toast(ui.errorText(err), 'error'); }

        ws.app('browser').then(function (h) {
            if (destroyed)
                return h.close();

            handle = h;

            if (onConnect)
                onConnect(h.sessionId);

            h.on('restore', function () {
                if (onConnect)
                    onConnect(h.sessionId);
                start();
            });

            start();
        }, function (e) { fail(e); });

        function editPath() {
            dom_search.classList.add('is-editing');
            dom_search.textContent = "";

            var input = document.createElement('input');
            input.value = path;
            input.setAttribute('aria-label', 'Path');
            input.spellcheck = false;
            dom_search.appendChild(input);

            input.focus();
            input.select();

            var done = function (apply) {
                if (!dom_search.contains(input))
                    return;

                var v = input.value.trim();

                goto(v);
            };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); done(true); }
                if (e.key === 'Escape') { e.stopPropagation(); done(false); }
            });
            input.addEventListener('blur', function () { done(false); });
        }
        dom_search.addEventListener('click', function (e) { if (e.target === dom_search) editPath(); });

        function goto(url) {
            dom_search.classList.remove('is-editing');

            handle.fetch('uri', { uri: url }).then(function (r) {
                dom_search.textContent = url;
                path = url;

                if (r.status == "ok") {
                    if (r.content_type == "html") {
                        dom_main_area.innerHTML = r.body.content;
                    }
                } else if (r.status == "not_found") {
                    dom_main_area.innerHTML = "<h1>Not found</h1>"
                }
            }, function (err) {
                fail(err);
            });
        }

        function start() {
            dom_main_area.innerHTML = "Welcome.";

            handleIntent(options.args || {});
        }

        function handleIntent(args) {
            if (args && args.path && handle) {
                goto(`local://${args.path}`, { reveal: true });
            }
        }

        function reload() {
            goto(path);
        }

        rootEl.addEventListener('click', function (e) {
            var b = e.target.closest('[data-act]');
            if (!b || b.disabled) return;
            ({
                back: function () { if (back.length) { forward.push(path); go(back.pop(), { push: false }); } },
                forward: function () { if (forward.length) { back.push(path); go(forward.pop(), { push: false }); } },
                refresh: reload,
            })[b.dataset.act]();
        });

        return {
            handleIntent: handleIntent,
            nonStandaloneDestroy: function () {
                destroyed = true;

                clearTimeout(reloadTimer);

                if (handle)
                    handle.close();
            }
        };
    };
})();
