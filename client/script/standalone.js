(function () {
    document.setupApp = document.setupApp || {};

    document.onloaded = function () {
        var apps = __apps.getInstance();
        apps.find(document.body.dataset.app).then(function (app) {
            var root = document.getElementById('app');
            var host = {
                setTitle: function (t) { document.title = t ? t + ' - ' + app.name : app.title; },
                close: function () { window.close(); },
                focus: function () { window.focus(); },
                launch: function (id, a) { return apps.open(id, a); },
                isDesktop: false
            };
            document.title = app.title;
            var wrap = document.createElement('div');
            wrap.className = 'app-fill';
            root.appendChild(wrap);
            var args = apps.initialArgs();
            document.appInstance = document.setupApp[app.setup](wrap, true, undefined, function () { }, { args: args, host: host });

            window.addEventListener('message', function (e) {
                if (e.origin === location.origin && e.data && e.data.type === 'intent' && document.appInstance && document.appInstance.handleIntent)
                    document.appInstance.handleIntent(e.data.args || {});
            });
        });
    };
})();
