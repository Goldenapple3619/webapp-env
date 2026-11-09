/**
 * __renderer   - load / error screen glue.
 * __preLoader  - script helpers.
 * __appHandler - loads an app's manifest (index.json) and builds DOM from its UI templates.
 *
 * Same names and call shapes as the first version. What changed underneath: loading is parallel
 * (see lloader.loadManifest), the readiness polling loop is a promise, and a second manifest can be
 * loaded on demand with loadApp(): that is how the desktop opens an app without having downloaded
 * every app's code at start-up.
 */
var __renderer = (() => {
    var instance = null;

    function init() {
        var errorDisplay = null, loadDisplay = null;
        return ({
            registerErrorDisplay: function (display) { errorDisplay = display; },
            registerLoadDisplay: function (display) { loadDisplay = display; },
            showLoad: function (message) { if (loadDisplay) loadDisplay.show(message); },
            hideLoad: function () { if (loadDisplay) loadDisplay.hide(); },
            showError: function (message, details) { if (errorDisplay) errorDisplay.show(message, details); else console.error(message, details); },
            hideError: function () { if (errorDisplay) errorDisplay.hide(); }
        });
    }

    return ({
        getInstance: function () {
            if (instance === null) instance = init();
            return instance;
        }
    });
})();

var __preLoader = (() => {
    return ({
        invokeScript: function (scriptUrl) { return __lloader.getInstance().loadScript(scriptUrl); },
        invokeScripts: function (urls) { return Promise.all(urls.map(function (u) { return __lloader.getInstance().loadScript(u); })); },
        /** kept for compatibility: loads in order, one after the other (the loader no longer needs it) */
        listCallbackAlgorithm: function (list, callback, onFinish, onError) {
            var i = 0;
            (function next() {
                if (i >= list.length) return onFinish && onFinish();
                callback(list[i++]).then(next, onError);
            })();
        }
    });
})();

var __appHandler = (() => {
    var instance = null;

    function init(toPreload) {
        var library = __lloader.getInstance();
        var error = null, loaded = false, subscribers = [];

        var ready = library.loadManifest(toPreload, function (info) {
            subscribers.forEach(function (s) { if (s.load) s.load(info); });
        }).then(function () { loaded = true; }, function (err) {
            error = err && err.message ? err : { status: false, message: 'Failed to load ' + toPreload };
            throw error;
        });
        ready.catch(function () { /* surfaced through onReady */ });

        /** replaces "${KEY}" by a value in every text node (replacerText) or in innerHTML (replacerHTML) */
        function applyReplacers(root, replacerText, replacerHTML) {
            replacerHTML = replacerHTML || {};
            replacerText = replacerText || {};
            var htmlKeys = Object.keys(replacerHTML), textKeys = Object.keys(replacerText);
            if (htmlKeys.length) {
                var html = root.innerHTML;
                htmlKeys.forEach(function (k) { html = html.split(k).join(replacerHTML[k]); });
                root.innerHTML = html;
            }
            if (textKeys.length) {
                var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                var node;
                while ((node = walker.nextNode())) {
                    textKeys.forEach(function (k) { if (node.nodeValue.indexOf(k) >= 0) node.nodeValue = node.nodeValue.split(k).join(replacerText[k]); });
                }
                // attributes too (e.g. title="${NAME}", alt, placeholder)
                root.querySelectorAll('*').forEach(function (n) {
                    Array.prototype.forEach.call(n.attributes, function (a) {
                        textKeys.forEach(function (k) { if (a.value.indexOf(k) >= 0) n.setAttribute(a.name, a.value.split(k).join(replacerText[k])); });
                    });
                });
            }
        }

        function build(toBuild, parent, replacerText, replacerHTML, imagesAsset) {
            var ui = library.getUI(toBuild);
            if (!ui) throw new Error('UI template not loaded: ' + toBuild);
            var clone = ui.cloneNode(true);
            applyReplacers(clone, replacerText, replacerHTML);
            if (imagesAsset) {
                clone.querySelectorAll('img[data-asset]').forEach(function (img) {
                    var a = library.getImageAsset(img.dataset.asset);
                    if (a) img.src = a.src;
                });
            }
            var last = null;                                  // the root ELEMENT (templates end with whitespace text nodes)
            while (clone.firstChild) { var node = clone.firstChild; if (node.nodeType === 1) last = node; parent.appendChild(node); }
            return last;
        }

        /** like build() but returns the cloned container (used for embedded sub-views) */
        function buildStandalone(toBuild, replacerText, replacerHTML, imagesAsset) {
            var holder = document.createElement('div');
            holder.style.width = '100%';
            holder.style.height = '100%';
            build(toBuild, holder, replacerText, replacerHTML, imagesAsset);
            return holder;
        }

        return ({
            isLoaded: function () { return loaded; },
            hasError: function () { return error !== null; },
            getError: function () { return error; },
            getLibrary: function () { return library; },
            setTitle: function (title) { document.title = title; },
            /** onReady(callback, load, error): load(info) is called for every loaded resource */
            onReady: function (callback, load, errorCallback) {
                if (load) subscribers.push({ load: load });
                ready.then(function () { callback(); }, function (err) { if (errorCallback) errorCallback(err); });
            },
            /** Loads another app's manifest (idempotent). Resolves when all its files are ready. */
            loadApp: function (manifestUrl) { return library.loadManifest(manifestUrl); },
            build: build,
            buildStandalone: buildStandalone
        });
    }

    return ({
        getInstance: function (toPreload) {
            if (instance === null) instance = init(toPreload);
            return instance;
        }
    });
})();
