/**
 * __ws - websocket client of the apps gateway.
 *
 * Kept from the first version: __ws.new(...) -> instance with open / close / send / setRoute /
 * setReconnect / connectApp / closeApp / setReady / getReady / onReady.
 *
 * New:
 *  - the instance authenticates itself (connect + access token) and re-authenticates silently each
 *    time the access token is refreshed, so a socket outlives many 15-minute tokens,
 *  - request(action, data) -> Promise, correlated by a request id the server echoes back,
 *  - app(name) -> handle { fetch(), update(), on(), close() } that transparently restarts its server
 *    side session after a reconnect and receives pushed events (e.g. "fs_changed"),
 *  - heartbeat (+ latency measurement), exponential backoff reconnect, status events.
 *
 * `urls` are the gateways returned by /api/wsockets, tried in priority order.
 */
var __ws = (() => {
    function init(urls, options) {
        options = options || {};
        var getToken = options.getToken;                    // () => Promise<string>
        var socket = null;
        var status = { state: 'idle', latency: null, attempts: 0 };
        var statusListeners = [];
        var ready = false, readyCallbacks = [];
        var pending = {};                                   // rid -> { resolve, reject, timer }
        var rid = 0, ident = 0;
        var routes = {};                                    // action -> callback  (setRoute)
        var reconnectCallback = null;
        var handles = [];                                   // live app handles
        var closedByUs = false, reconnectTimer = null, heartbeatTimer = null, opening = null;
        var legacySessions = {};                            // sid -> { route: callback }   (connectApp)

        function setStatus(patch) {
            Object.assign(status, patch);
            statusListeners.slice().forEach(function (cb) { try { cb(Object.assign({}, status)); } catch (e) { console.error(e); } });
        }

        // ------------------------------------------------------------------------------ transport
        function openSocket(url) {
            return new Promise(function (resolve, reject) {
                var ws;
                try { ws = new WebSocket(url); } catch (e) { return reject(e); }
                var timer = setTimeout(function () { try { ws.close(); } catch (e) { /* */ } reject(new Error('timeout')); }, 8000);
                ws.onopen = function () { clearTimeout(timer); ws.onerror = null; resolve(ws); };
                ws.onerror = function () { clearTimeout(timer); reject(new Error('connection_failed')); };
            });
        }

        function failPending(reason) {
            Object.keys(pending).forEach(function (k) {
                clearTimeout(pending[k].timer);
                pending[k].reject(Object.assign(new Error(reason), { code: reason }));
                delete pending[k];
            });
        }

        function attach(ws) {
            socket = ws;
            ws.onmessage = function (ev) {
                var msg;
                try { msg = JSON.parse(ev.data); } catch (e) { return; }
                dispatch(msg);
            };
            ws.onclose = function (ev) {
                if (socket !== ws) return;
                socket = null; ready = false;
                clearInterval(heartbeatTimer);
                failPending('connection_closed');
                setStatus({ state: 'closed' });
                if (!closedByUs && ev.code !== 4401) scheduleReconnect();
            };
        }

        function dispatch(msg) {
            if (msg.rid != null && pending[msg.rid]) {
                var p = pending[msg.rid];
                delete pending[msg.rid];
                clearTimeout(p.timer);
                p.resolve(msg);
                return;
            }
            if (msg.action && msg.action.indexOf('event_') === 0) {
                var sid = msg.action.slice(6);
                handles.forEach(function (h) { if (h.sessionId === sid) h._emit(msg.data.event, msg.data); });
                return;
            }
            if (msg.action === 'session_ended') {                       // revoked / expired server side
                ready = false;
                closedByUs = true;
                setStatus({ state: 'closed' });
                if (options.onSessionEnded) options.onSessionEnded(msg.data && msg.data.message);
                return;
            }
            var cb = routes[msg.action];
            if (cb) { cb(msg); return; }
            // legacy per-session routes: "<route>_<sessionId>"
            var cut = msg.action.lastIndexOf('_');
            if (cut > 0 && legacySessions[msg.action.slice(cut + 1)]) {
                var r = legacySessions[msg.action.slice(cut + 1)][msg.action.slice(0, cut)];
                if (r) r(msg);
            }
        }

        function send(message) {
            if (!socket || socket.readyState !== 1) return false;
            socket.send(typeof message === 'string' ? message : JSON.stringify(message));
            return true;
        }

        /** Sends {action, data} and resolves with the matching reply. */
        function request(action, data, opts) {
            opts = opts || {};
            return new Promise(function (resolve, reject) {
                var id = ++rid;
                if (!send({ action: action, data: data || {}, rid: id }))
                    return reject(Object.assign(new Error('not_connected'), { code: 'not_connected' }));
                pending[id] = {
                    resolve: resolve, reject: reject,
                    timer: setTimeout(function () { delete pending[id]; reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, opts.timeout || 20000)
                };
            });
        }

        // ------------------------------------------------------------------------------ auth + connect
        function authenticate() {
            return getToken().then(function (token) {
                return request('connect', { token: token }, { timeout: 10000 });
            }).then(function (msg) {
                if (msg.data.message !== 'ok') throw Object.assign(new Error(msg.data.reason || 'auth_failed'), { code: msg.data.reason || 'auth_failed', auth: true });
                return msg.data;
            });
        }

        /** Renews the identity on the open socket (called whenever the access token changed). */
        function reauth() {
            if (!socket || !ready) return Promise.resolve();
            return authenticate().catch(function (e) { if (e.auth && options.onSessionEnded) options.onSessionEnded(e.code); });
        }

        function connectOnce() {
            var lastError = new Error('no_gateway');
            var chain = Promise.reject(lastError);
            urls.forEach(function (url) {
                chain = chain.catch(function () { return openSocket(url).then(function (ws) { return ws; }); });
            });
            return chain.then(function (ws) {
                closedByUs = false;
                attach(ws);
                return authenticate().catch(function (e) { try { ws.close(); } catch (x) { /* */ } throw e; });
            }).then(function (info) {
                ready = true;
                setStatus({ state: 'open', attempts: 0 });
                startHeartbeat();
                return info;
            });
        }

        function open() {
            if (opening) return opening;
            setStatus({ state: 'connecting' });
            opening = connectOnce().then(function (info) {
                opening = null;
                flushReady();
                return { status: true, data: info };
            }, function (err) {
                opening = null;
                setStatus({ state: 'closed' });
                throw { status: false, error: err, auth: !!err.auth };
            });
            return opening;
        }

        function flushReady() {
            var cbs = readyCallbacks; readyCallbacks = [];
            cbs.forEach(function (cb) { cb(); });
        }

        function attemptReconnect() {
            reconnectTimer = null;
            if (closedByUs) return;
            open().then(restoreApps).catch(function (e) {
                if (e.auth) { if (options.onSessionEnded) options.onSessionEnded(e.error && e.error.code); }
                else scheduleReconnect();
            });
        }

        function scheduleReconnect() {
            if (reconnectTimer || closedByUs) return;
            var n = status.attempts + 1;
            var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(n, 5))) * (0.75 + Math.random() * 0.5);
            setStatus({ attempts: n });
            reconnectTimer = setTimeout(attemptReconnect, delay);
        }

        // Something says the connection is probably usable again (the tab woke up, the network came back): try
        // right now instead of waiting for the backoff timer. (This used to start a NEW backoff, i.e. wait longer.)
        function reconnectNow() {
            if (closedByUs || status.state !== 'closed') return;
            clearTimeout(reconnectTimer);
            attemptReconnect();
        }
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') reconnectNow();
        });
        window.addEventListener('online', reconnectNow);

        function startHeartbeat() {
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(function () {
                var t0 = performance.now();
                request('ping', {}, { timeout: 10000 }).then(function () {
                    setStatus({ latency: Math.round(performance.now() - t0) });
                }).catch(function () {
                    if (socket) try { socket.close(); } catch (e) { /* triggers reconnect */ }
                });
            }, 25000);
            // first measurement right away
            var t1 = performance.now();
            request('ping', {}).then(function () { setStatus({ latency: Math.round(performance.now() - t1) }); }).catch(function () {});
        }

        function restoreApps() {
            var jobs = handles.slice().map(function (h) {
                return startHandle(h).then(function () { h._emit('restore', {}); }).catch(function () { h._emit('lost', {}); });
            });
            return Promise.all(jobs).then(function () { if (reconnectCallback) reconnectCallback(); });
        }

        // ------------------------------------------------------------------------------------- apps
        function whenReady() {
            if (ready) return Promise.resolve();
            return new Promise(function (resolve) { readyCallbacks.push(resolve); });
        }

        function appError(msg) {
            var d = msg.data || {};
            return Object.assign(new Error(d.error || d.message || 'error'), { code: d.error || d.message, details: d.details });
        }

        function startHandle(h) {
            return whenReady().then(function () {
                return request('start_app', { name: h.name, identifier: 'h' + (++ident) });
            }).then(function (msg) {
                if (msg.data.message !== 'start_done') throw appError(msg);
                h.sessionId = msg.data.session_id;
            });
        }

        /**
         * const files = await ws.app('explorer');
         * const listing = await files.fetch('listdir', { path: '/' });
         * await files.update('mkdir', { path: '/', name: 'x' });
         * files.on('fs_changed', data => ...); files.on('restore', ...); files.close();
         */
        function app(name) {
            var h = {
                name: name, sessionId: null, closed: false, _l: {},
                on: function (ev, cb) { (h._l[ev] = h._l[ev] || []).push(cb); return h; },
                _emit: function (ev, data) { (h._l[ev] || []).slice().forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } }); },
                fetch: function (type, query) { return call(h, 'fetch', type, query); },
                update: function (type, query) { return call(h, 'update', type, query); },
                close: function () {
                    if (h.closed) return;
                    h.closed = true;
                    handles = handles.filter(function (x) { return x !== h; });
                    if (ready && h.sessionId) send({ action: 'close_app', data: { app_session: h.sessionId } });
                }
            };
            handles.push(h);
            return startHandle(h).then(function () { return h; }, function (e) {
                handles = handles.filter(function (x) { return x !== h; });
                throw e;
            });
        }

        function call(h, kind, type, query, retried) {
            if (h.closed) return Promise.reject(Object.assign(new Error('closed'), { code: 'closed' }));
            var data = { app_session: h.sessionId, query: query || {} };
            data[kind + '_type'] = type;
            return whenReady().then(function () { return request(kind + '_app', data); }).then(function (msg) {
                var d = msg.data || {};
                if ((d.message === 'token_expired' || msg.code === 401) && !retried)
                    return reauth().then(function () { return call(h, kind, type, query, true); });
                if (d.message !== (kind === 'fetch' ? 'fetch_done' : 'update_done')) throw appError(msg);
                return d.value !== undefined ? d.value : true;
            });
        }

        // ---------------------------------------------------------------- legacy API (first version)
        function connectApp(appName, appRoutes, onOpen, onRestore, onError, onErrorRestore) {
            var first = true;
            return app(appName).then(function (h) {
                legacySessions[h.sessionId] = appRoutes || {};
                h.on('restore', function () { legacySessions[h.sessionId] = appRoutes || {}; if (onRestore) onRestore(h.sessionId); });
                h.on('lost', function () { if (onErrorRestore) onErrorRestore(); });
                if (onOpen) onOpen(h.sessionId, h);
                first = false;
                return h;
            }).catch(function (e) { if (first && onError) onError(e); else throw e; });
        }

        return ({
            open: open,
            close: function () {
                closedByUs = true;
                clearTimeout(reconnectTimer); reconnectTimer = null;
                clearInterval(heartbeatTimer);
                if (socket) { try { send({ action: 'goodbye' }); socket.close(1000); } catch (e) { /* */ } }
                ready = false;
            },
            send: send,
            request: request,
            app: app,
            reauth: reauth,
            whenReady: whenReady,
            setRoute: function (action, cb) { routes[action] = cb; },
            setReconnect: function (cb) { reconnectCallback = cb; },
            connectApp: connectApp,
            closeApp: function (sessionId) {
                handles.filter(function (h) { return h.sessionId === sessionId; }).forEach(function (h) { h.close(); });
                delete legacySessions[sessionId];
                if (ready) send({ action: 'close_app', data: { app_session: sessionId } });
            },
            setReady: function (v) { ready = !!v; if (ready) flushReady(); },
            getReady: function () { return ready; },
            onReady: function (cb) { if (ready) cb(); else readyCallbacks.push(cb); },
            onStatus: function (cb) { statusListeners.push(cb); cb(Object.assign({}, status)); return function () { statusListeners = statusListeners.filter(function (x) { return x !== cb; }); }; },
            getStatus: function () { return Object.assign({}, status); }
        });
    }

    /** __ws.new(urls | url, { getToken, onSessionEnded }) */
    return ({ new: function (urls, options) { return init(Array.isArray(urls) ? urls : [urls], options); } });
})();
