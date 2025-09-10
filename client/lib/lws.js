var __ws = (() => {
    function init(url) {
        var gracefulClose = false;
        var ws = null;
        var reconnectCallback = null;
        var routes = {};
        var starterRoutes = {};
        var appSessions = {};
        var ready = false;
        var identifier = 0;

        function close() {
            gracefulClose = true;

            if (!ws || ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
                ws = null;
                return;
            }

            ws.close();
            ws = null;
        }

        function send(data) {
            ws.send(data);
        }

        function open() {
            return (new Promise((resolve, reject) => {
                ws = new WebSocket(url);

                ws.onmessage = ((event) => {
                    let msg = JSON.parse(event.data);

                    if (routes[msg["action"]])
                        routes[msg["action"]](ws, msg);

                    Object.keys(starterRoutes).forEach(x => {
                        if (x === msg["action"]) {
                            starterRoutes[x](ws, msg);
                            delete starterRoutes[x];
                        }
                    });

                    Object.keys(appSessions).forEach(x => {
                        Object.keys(appSessions[x].routes).forEach(route => {
                            if (route + '_' + x == msg["action"])
                                appSessions[x].routes[route](ws, msg);
                        });
                    });
                });

                ws.onclose = ((event) => {
                    if (gracefulClose) {
                        return;
                    }
                    (new Promise(resolve => setTimeout(resolve, 1024 * 10))).then(() => {
                        open().then((data) => {
                            if (reconnectCallback)
                                reconnectCallback(data);
                            let newAppSession = {};

                            Object.keys(appSessions).forEach(x => {
                                var temp = appSessions[x];

                                starterRoutes[`start_app_id_${identifier}`] = ((ws, msg) => {
                                    if (msg.code != 0 || msg.data.message !== "start_done") {
                                        if (temp.callback_error_restore)
                                            temp.callback_error_restore(msg);
                                        return;
                                    }
                                    newAppSession[msg.data.session_id] = {appType: temp.appType, restore: temp.restore, routes: temp.routes, callback_error_restore: temp.callback_error_restore};
                                    temp.restore(msg.data.session_id);
                                });

                                send(JSON.stringify({action: "start_app", data: {name: temp.appType, identifier: `id_${identifier++}`}}));
                            });
                            appSessions = newAppSession;
                        }).catch((err) => {

                        });
                    });
                });

                if (ws.readyState === ws.OPEN)
                    return resolve({status: true, data: ws});
                ws.onopen = (event) => {
                    resolve({status: true, data: ws});
                };
                ws.onerror = (err) => {
                    reject({status: true, error: err});
                };
            }));
        }

        function setRoute(route, callback) {
            routes[route] = callback;
        }

        function setReconnect(callback) {
            reconnectCallback = callback;
        }

        function connectApp(appName, routesApp, callback_open, callback_restore, callback_error, callback_error_restore) {
            starterRoutes[`start_app_id_${identifier}`] = ((ws, msg) => {
                if (msg.code != 0 || msg.data.message !== "start_done") {
                    if (callback_error)
                        callback_error(msg);
                    return;
                }
                appSessions[msg.data.session_id] = {appType: appName, restore: callback_restore, routes: routesApp, callback_error_restore: callback_error_restore};
                callback_open(msg.data.session_id);
            });
            send(JSON.stringify({action: "start_app", data: {name: appName, identifier: `id_${identifier++}`}}));
        }

        function closeApp(appid) {
            delete appSessions[appid];
            send(JSON.stringify({action: "close_app", data: {app_session: appid}}));
        }

        function onReady(callback) {
            var interval = setInterval(() => {
                if (ready) {
                    clearInterval(interval);
                    callback();
                }
            }, 0);
        }

        function onReady(callback) {
            var interval = setInterval(() => {
                if (ready) {
                    clearInterval(interval);
                    callback();
                }
            }, 0);
        }

        function setReady(state) {
            ready = state;
        }

        function getReady() {
            return ready;
        }

        return ({
            open: open,
            close: close,
            setRoute: setRoute,
            setReconnect: setReconnect,
            send: send,
            connectApp: connectApp,
            setReady: setReady,
            getReady: getReady,
            onReady: onReady,
            closeApp: closeApp
        });
    }

    return ({
        new: init
    });
})();
