var __auth = (() => {
    var instance = null;

    function init() {
        var HINT = 'gz_session_hint';
        var token = null, expiresAt = 0, user = null, sessionId = null;
        var timer = null, inflight = null;
        var version = 0;
        var listeners = [];
        var channel = ('BroadcastChannel' in window) ? new BroadcastChannel('webapp-env-auth') : null;

        function base() {
            var h = (localStorage.getItem('host') || '').trim();
            if (!h) return '';
            if (!/^https?:\/\//i.test(h)) h = (location.protocol === 'https:' ? 'https://' : 'http://') + h;
            return h.replace(/\/+$/, '');
        }
        function apiBase() { return base() + '/api'; }
        function crossOrigin() { var b = base(); return b !== '' && new URL(b).origin !== location.origin; }
        function encPath(p) { return '/' + String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
        function fileUrl(path, opts) {
            var p = encPath(path);
            return apiBase() + '/my' + (p === '/' ? '' : p) + (opts && opts.download ? '?download' : opts && opts.zip ? '?zip' : '');
        }

        function emit(type) {
            listeners.slice().forEach(function (cb) { try { cb(type, state()); } catch (e) { console.error(e); } });
        }
        function state() { return { token: token, expiresAt: expiresAt, user: user, sessionId: sessionId }; }

        function adopt(body, fromOtherTab) {
            version++;
            token = body.accessToken;
            expiresAt = body.expiresAt || (Date.now() + body.expiresIn * 1000);
            user = body.user;
            sessionId = body.sessionId;
            try { localStorage.setItem(HINT, '1'); } catch (e) { /* private mode */ }
            schedule();
            emit('token');
            if (!fromOtherTab && channel)
                channel.postMessage({ type: 'token', body: { accessToken: token, expiresAt: expiresAt, user: user, sessionId: sessionId } });
        }

        function clear(reason, fromOtherTab) {
            token = null; expiresAt = 0; user = null; sessionId = null;
            clearTimeout(timer);
            try { localStorage.removeItem(HINT); } catch (e) { /* ignore */ }
            emit('cleared:' + (reason || 'unknown'));
            if (!fromOtherTab && channel) channel.postMessage({ type: 'cleared', reason: reason });
        }

        if (channel) {
            channel.onmessage = function (ev) {
                if (ev.data.type === 'token') adopt(ev.data.body, true);
                if (ev.data.type === 'cleared') clear(ev.data.reason || 'other_tab', true);
            };
        }

        function schedule() {
            clearTimeout(timer);
            var wait = Math.max(5000, expiresAt - Date.now() - 60000);
            timer = setTimeout(function () { refresh().catch(function () { /* retried on demand */ }); }, wait);
        }

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && token && expiresAt - Date.now() < 45000) refresh().catch(function () {});
        });
        window.addEventListener('online', function () {
            if (token && expiresAt - Date.now() < 45000) refresh().catch(function () {});
        });

        function send(path, opts) {
            var headers = Object.assign({}, opts.headers || {});
            var body;
            if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
            if (opts.bearer) headers.Authorization = 'Bearer ' + opts.bearer;
            return fetch(apiBase() + path, {
                method: opts.method || 'GET', headers: headers, body: body,
                credentials: crossOrigin() ? 'include' : 'same-origin', signal: opts.signal
            }).then(function (res) {
                return res.text().then(function (text) {
                    var data = null;
                    try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
                    if (!res.ok) {
                        var err = new Error((data && data.message) || res.statusText || 'request_failed');
                        err.status = res.status; err.code = data && data.message; err.data = data;
                        throw err;
                    }
                    return data;
                });
            }, function (e) {
                if (e && e.name === 'AbortError') throw e;
                var err = new Error('network_error'); err.network = true; err.cause = e;
                throw err;
            });
        }

        function refresh() {
            if (inflight) return inflight;
            var seen = version;
            var run = function () {
                if (version !== seen && token && expiresAt - Date.now() > 20000) return Promise.resolve(token);
                return send('/auth/refresh', { method: 'POST' }).then(function (body) {
                    adopt(body);
                    return token;
                }).catch(function (err) {
                    if (err.status === 401) clear('expired');
                    throw err;
                });
            };
            inflight = (navigator.locks ? navigator.locks.request('webapp-env-refresh', run) : run())
                .finally(function () { inflight = null; });
            return inflight;
        }

        function ensure() {
            if (token && expiresAt - Date.now() > 20000) return Promise.resolve(token);
            return refresh();
        }

        function restore() {
            return ensure().then(function () { return true; }, function (err) {
                if (err.network) throw err;
                return false;
            });
        }

        function hasHint() { try { return localStorage.getItem(HINT) === '1'; } catch (e) { return false; } }

        function login(username, password) {
            return send('/auth/login', { method: 'POST', json: { username: username, password: password } }).then(function (b) { adopt(b); return b; });
        }
        function register(username, password) {
            return send('/auth/register', { method: 'POST', json: { username: username, password: password } }).then(function (b) { adopt(b); return b; });
        }
        function logout() {
            return send('/auth/logout', { method: 'POST', bearer: token }).catch(function () {}).then(function () { clear('logout'); });
        }

        function request(path, opts) {
            opts = opts || {};
            var attempt = function (retry) {
                return ensure().then(function (t) {
                    return send(path, Object.assign({}, opts, { bearer: t }));
                }).catch(function (err) {
                    if (err.status === 401 && retry) {
                        expiresAt = 0;
                        return attempt(false);
                    }
                    throw err;
                });
            };
            return attempt(true);
        }

        var cachedConfig = null;
        function getConfig() {
            if (!cachedConfig) cachedConfig = send('/config', {}).catch(function () { cachedConfig = null; return { registration: true }; });
            return cachedConfig;
        }

        function upload(path, file, opts) {
            opts = opts || {};
            return ensure().then(function (t) {
                return new Promise(function (resolve, reject) {
                    var qs = [];
                    if (opts.overwrite) qs.push('overwrite=1');
                    if (opts.parents) qs.push('parents=1');
                    var x = new XMLHttpRequest();
                    x.open('PUT', apiBase() + '/my' + encPath(path) + (qs.length ? '?' + qs.join('&') : ''));
                    x.setRequestHeader('Authorization', 'Bearer ' + t);
                    x.withCredentials = crossOrigin();
                    if (opts.onProgress) x.upload.onprogress = function (e) { if (e.lengthComputable) opts.onProgress(e.loaded, e.total); };
                    x.onload = function () {
                        var data = null;
                        try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
                        if (x.status >= 200 && x.status < 300) return resolve(data);
                        var err = new Error((data && data.message) || 'upload_failed');
                        err.status = x.status; err.code = data && data.message;
                        reject(err);
                    };
                    x.onerror = function () { var e = new Error('network_error'); e.network = true; reject(e); };
                    x.onabort = function () { var e = new Error('aborted'); e.aborted = true; reject(e); };
                    if (opts.signal) opts.signal.addEventListener('abort', function () { x.abort(); });
                    x.send(file);
                });
            });
        }

        return ({
            base: base, apiBase: apiBase, fileUrl: fileUrl, crossOrigin: crossOrigin,
            state: state, getToken: function () { return token; }, getUser: function () { return user; },
            ensure: ensure, refresh: refresh, restore: restore, hasHint: hasHint,
            login: login, register: register, logout: logout,
            request: request, upload: upload, getConfig: getConfig,
            onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; }
        });
    }

    return ({
        getInstance: function () {
            if (instance === null) instance = init();
            return instance;
        }
    });
})();
