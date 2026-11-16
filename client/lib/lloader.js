var __lloader = (() => {
    var instance = null;

    function init() {
        var images = {};
        var UIs = {};
        var JSONs = {};
        var pending = { ui: {}, json: {}, image: {}, css: {}, script: {}, manifest: {} };

        function abs(url, base) {
            var u = new URL(url, new URL(base || location.href, location.href));
            return u.origin === location.origin ? u.pathname + u.search : u.href;
        }

        function versioned(url) {
            var map = window.__V;
            if (!map || /^https?:/i.test(url)) return url;
            var v = map[url.split('?')[0]];
            return v ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v : url;
        }

        function once(bucket, key, factory) {
            if (!pending[bucket][key])
                pending[bucket][key] = factory().catch(function (err) {
                    delete pending[bucket][key]; // allow a later retry
                    throw err;
                });
            return pending[bucket][key];
        }

        function request(url, body, method, headers) {
            method = method || 'GET';
            return fetch(url, { method: method, headers: headers || {}, body: body, credentials: 'same-origin' }).then(function (res) {
                return res.text().then(function (text) {
                    var req = {
                        status: res.status, statusText: res.statusText, responseText: text, ok: res.ok,
                        getResponseHeader: function (n) { return res.headers.get(n); }
                    };
                    if (res.ok) return { status: true, loaded: url, type: 'url', request: req };
                    throw { status: false, request: req, message: 'invalid response code from ' + method + ' ' + url + ' (code: ' + res.status + ')' };
                });
            }, function (err) {
                throw { status: false, error: err, message: 'unknown error when requesting ' + method + ' ' + url };
            });
        }

        function invokeCSS(cssUrl) {
            var key = abs(cssUrl);
            return once('css', key, function () {
                return new Promise(function (resolve, reject) {
                    var existing = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
                        return new URL(l.getAttribute('href'), location.href).pathname === key.split('?')[0];
                    });
                    if (existing) return resolve({ status: true, loaded: key, type: 'style' });
                    var style = document.createElement('link');
                    style.rel = 'stylesheet';
                    style.href = versioned(key);
                    style.addEventListener('load', function () { resolve({ status: true, loaded: key, type: 'style' }); });
                    style.addEventListener('error', function () { reject({ status: false, message: 'Failed to load style ' + key }); });
                    document.head.appendChild(style);
                });
            });
        }

        function loadScript(scriptUrl) {
            var key = abs(scriptUrl);
            return once('script', key, function () {
                return new Promise(function (resolve, reject) {
                    var existing = Array.prototype.some.call(document.querySelectorAll('script[src]'), function (s) {
                        return new URL(s.getAttribute('src'), location.href).pathname === key.split('?')[0];
                    });
                    if (existing) return resolve({ status: true, loaded: key, type: 'script' });
                    var script = document.createElement('script');
                    script.async = false;
                    script.src = versioned(key);
                    script.addEventListener('load', function () { resolve({ status: true, loaded: key, type: 'script' }); });
                    script.addEventListener('error', function () { reject({ status: false, message: 'Failed to load script ' + key }); });
                    document.head.appendChild(script);
                });
            });
        }

        function loadJSON(url) {
            var key = abs(url);
            if (JSONs[key]) return Promise.resolve({ status: true, loaded: key, type: 'json', content: JSONs[key] });
            return once('json', key, function () {
                return request(versioned(key)).then(function (data) {
                    JSONs[key] = JSON.parse(data.request.responseText);
                    return { status: true, loaded: key, type: 'json', content: JSONs[key] };
                }).catch(function () { throw { status: false, message: 'Failed to load json ' + key }; });
            });
        }

        function loadUi(url) {
            var key = abs(url);
            if (UIs[key]) return Promise.resolve({ status: true, loaded: key, type: 'ui', content: UIs[key] });
            return once('ui', key, function () {
                return request(versioned(key)).then(function (data) {
                    var temp = document.createElement('div');
                    temp.style.width = '100%';
                    temp.style.height = '100%';
                    temp.innerHTML = data.request.responseText;
                    UIs[key] = temp;
                    return { status: true, loaded: key, type: 'ui', content: temp };
                }).catch(function () { throw { status: false, message: 'Failed to load ui ' + key }; });
            });
        }

        function loadImageAsset(assetUrl) {
            var key = abs(assetUrl);
            if (images[key]) return Promise.resolve({ status: true, loaded: key, type: 'image', content: images[key] });
            return once('image', key, function () {
                return new Promise(function (resolve, reject) {
                    var image = new Image();
                    image.addEventListener('load', function () { images[key] = image; resolve({ status: true, loaded: key, type: 'image', content: image }); });
                    image.addEventListener('error', function () { reject({ status: false, message: 'Failed to load image ' + key }); });
                    image.src = versioned(key);
                });
            });
        }

        function loadManifest(manifestUrl, onProgress) {
            var base = abs(manifestUrl);
            return once('manifest', base, function () {
                return loadJSON(base).then(function (res) {
                    var json = res.content;
                    var r = function (u) { return abs(u, base); };
                    var jobs = [];
                    var track = function (p) {
                        return p.then(function (d) { if (onProgress) onProgress(d); return d; });
                    };

                    (json.styles || []).forEach(function (u) { jobs.push(track(invokeCSS(r(u)))); });
                    (json.images || []).forEach(function (u) { jobs.push(track(loadImageAsset(r(u)))); });
                    (json.UIs || []).forEach(function (u) { jobs.push(track(loadUi(r(u)))); });
                    (json.JSONs || []).forEach(function (u) { jobs.push(track(loadJSON(r(u)))); });
                    (json.scripts || []).forEach(function (u) { jobs.push(track(loadScript(r(u)))); });
                    return Promise.all(jobs);
                });
            });
        }

        return ({
            abs: abs,
            versioned: versioned,
            invokeCSS: invokeCSS,
            loadScript: loadScript,
            loadImageAsset: loadImageAsset,
            loadUi: loadUi,
            request: request,
            loadJSON: loadJSON,
            loadManifest: loadManifest,
            getImageAsset: function (assetUrl) { return images[abs(assetUrl)]; },
            getUI: function (url) { return UIs[abs(url)]; },
            getJSON: function (url) { return JSONs[abs(url)]; }
        });
    }

    return ({
        getInstance: function () {
            if (instance === null) instance = init();
            return instance;
        }
    });
})();
