(function () {
    var body = document.body;
    var isPublic = body.dataset.page === 'public';
    var needsWs = body.dataset.ws !== 'false';
    var root = document.getElementById('app');
    var auth = __auth.getInstance();

    document.loaded = false;
    document.auth = auth;
    document.renderer = __renderer.getInstance();

    var bootText = root.querySelector('.boot__text');
    var bootError = root.querySelector('.boot__error');
    document.renderer.registerLoadDisplay({
        show: function (m) { if (bootText) bootText.textContent = m; },
        hide: function () { }
    });
    document.renderer.registerErrorDisplay({
        show: function (message, details) {
            var spinner = root.querySelector('.boot__spinner');
            if (spinner) spinner.style.display = 'none';
            if (bootText) bootText.style.display = 'none';
            if (!bootError) return console.error(message, details);
            bootError.style.display = 'flex';
            bootError.querySelector('.boot__error-message').textContent = message;
            if (details) bootError.querySelector('.boot__error-details').textContent = String(details);
        },
        hide: function () { if (bootError) bootError.style.display = 'none'; }
    });
    if (bootError) {
        var retry = bootError.querySelector('[data-retry]');
        if (retry) retry.addEventListener('click', function () { location.reload(); });
        var login = bootError.querySelector('[data-login]');
        if (login) login.addEventListener('click', function () { goLogin(); });
    }

    function safeNext(value) {
        if (typeof value !== 'string' || value.charAt(0) !== '/' || value.charAt(1) === '/' || value.charAt(1) === '\\') return null;
        return value;
    }
    function goLogin(reason) {
        var next = location.pathname + location.search + location.hash;
        var q = '?next=' + encodeURIComponent(next) + (reason ? '&reason=' + encodeURIComponent(reason) : '');
        location.replace('/connect/' + q);
    }
    document.goLogin = goLogin;
    document.safeNext = safeNext;

    function wsUrl(host) {
        if (/^wss?:\/\//i.test(host)) return host;
        var base = auth.base();
        var secure = base ? /^https:/i.test(base) : location.protocol === 'https:';
        var proto = secure ? 'wss' : 'ws';
        if (host.charAt(0) === '/') return proto + '://' + (base ? new URL(base).host : location.host) + host;
        return proto + '://' + host;
    }

    function connectGateway() {
        return auth.request('/wsockets').then(function (res) {
            var list = (res.wsockets || res.wssockets || []).map(function (s) { return wsUrl(typeof s === 'string' ? s : s.host); });
            if (!list.length) throw new Error('No gateway is registered (table wsockets is empty).');
            var ws = __ws.new(list, {
                getToken: auth.ensure,
                onSessionEnded: function () { auth.refresh().then(function () { return ws.open(); }).catch(function () { goLogin('expired'); }); }
            });
            document.wsscon = ws;
            // every refreshed access token is handed to the open socket
            auth.onChange(function (type) { if (type === 'token') ws.reauth(); });
            installConnectionBanner(ws);
            return ws.open();
        });
    }

    function installConnectionBanner(ws) {
        var banner = null, wasOpen = false;
        ws.onStatus(function (s) {
            if (s.state === 'open') { wasOpen = true; if (banner) { banner.remove(); banner = null; } return; }
            if (!wasOpen || s.state === 'idle') return;
            if (!banner) {
                banner = document.createElement('div');
                banner.setAttribute('role', 'status');
                banner.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:100002;padding:4px 14px;border-radius:0 0 12px 12px;background:#b3264f;color:#fff;font:12px var(--font-ui);box-shadow:0 2px 8px rgba(0,0,0,.3)';
                document.body.appendChild(banner);
            }
            banner.textContent = s.state === 'connecting' ? 'Reconnecting…' : 'Connection lost. Retrying' + (s.attempts ? ' (attempt ' + s.attempts + ')' : '') + '…';
        });
    }

    var manifest = location.pathname.replace(/[^/]*$/, '') + 'index.json';
    document.app = __appHandler.getInstance(manifest);

    var assets = new Promise(function (resolve, reject) {
        document.app.onReady(resolve, function (info) { document.renderer.showLoad('Loading ' + info.loaded.split('/').pop() + '…'); }, reject);
    });

    function finish() {
        document.loaded = true;
        root.textContent = '';
        var go = function () { if (typeof document.onloaded === 'function') document.onloaded(); else setTimeout(go, 10); };
        go();
    }

    function fail(message, err) {
        console.error(message, err);
        document.renderer.showError(message, err && (err.message || err.code));
    }

    function startPublic() {
        var resume = auth.hasHint() ? auth.restore().catch(function () { return false; }) : Promise.resolve(false);
        Promise.all([assets, resume]).then(function (r) {
            if (r[1]) {
                var next = safeNext(new URLSearchParams(location.search).get('next'));
                return location.replace(next || '/desktop/');
            }
            finish();
        }).catch(function (e) { fail('Failed to load the page.', e); });
    }

    function startProtected() {
        document.renderer.showLoad('Signing in…');
        var session = auth.restore();
        session.then(function (ok) {
            if (!ok) return goLogin();
            var steps = needsWs ? [assets, connectGateway()] : [assets];
            return Promise.all(steps).then(finish);
        }).catch(function (e) {
            if (e && e.network) return fail('The server cannot be reached.', e);
            if (e && e.auth) return goLogin('expired');
            fail((e && e.message) || 'Failed to start.', e && e.error);
        });

        auth.onChange(function (type) { if (type.indexOf('cleared:') === 0) goLogin(type.slice(8)); });
    }

    if (isPublic) startPublic(); else startProtected();
})();
