var __window = (() => {
    var zTop = 20, seq = 0, opened = 0;
    var registry = [];
    var listeners = [];
    var DEFAULT_MIN = [260, 160];
    var SIZE_KEY = 'webapp.winsize.v1';

    function emit(type, w) { listeners.slice().forEach(function (cb) { try { cb(type, w); } catch (e) { console.error(e); } }); }
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(Math.max(lo, hi), v)); };
    function icon(name) { return '<svg class="icon"><use href="/assets/images/icons.svg#' + name + '"/></svg>'; }

    function sizes() { try { return JSON.parse(localStorage.getItem(SIZE_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function remember(appId, w, h) {
        if (!appId) return;
        try { var s = sizes(); s[appId] = [Math.round(w), Math.round(h)]; localStorage.setItem(SIZE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
    }

    function fitRect(r, min, pw, ph) {
        var w = clamp(r.width, Math.min(min[0], pw), pw), h = clamp(r.height, Math.min(min[1], ph), ph);
        return { width: w, height: h, left: clamp(r.left, Math.min(0, pw - w), Math.max(0, pw - w)), top: clamp(r.top, 0, Math.max(0, ph - h)) };
    }

    function init(title, size, parent, onclose, marginMinimizePos, meta) {
        meta = meta || {};
        size = size || [800, 600];
        parent = parent || document.body;
        var id = ++seq;
        var min = Array.isArray(meta.minSize) ? [meta.minSize[0], meta.minSize[1]] : DEFAULT_MIN.slice();

        var el = document.createElement('div');
        el.className = 'window is-opening';
        el.setAttribute('role', 'dialog');
        if (meta.appId) el.dataset.app = meta.appId;
        el.innerHTML =
            '<div class="win-frame">' +
              '<div class="win-header">' +
                '<h5 class="win-title"></h5>' +
                '<div class="win-buttons">' +
                  '<button type="button" class="win-button-minimize" title="Minimize" aria-label="Minimize">' + icon('minus') + '</button>' +
                  '<button type="button" class="win-button-maximize" title="Maximize" aria-label="Maximize">' + icon('maximize') + '</button>' +
                  '<button type="button" class="win-button-close" title="Close" aria-label="Close">' + icon('x') + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="win-body"></div>' +
            '</div>';
        ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (edge) {
            var h = document.createElement('div');
            h.className = 'win-resize';
            h.dataset.edge = edge;
            el.appendChild(h);
        });
        var header = el.querySelector('.win-header');
        var titleEl = el.querySelector('.win-title');
        var body = el.querySelector('.win-body');
        var btnMax = el.querySelector('.win-button-maximize');
        titleEl.textContent = title;
        el.setAttribute('aria-label', title);
        el.style.minWidth = min[0] + 'px';
        el.style.minHeight = min[1] + 'px';

        var pw = parent.clientWidth || innerWidth, ph = parent.clientHeight || innerHeight;
        var wanted = size;
        if (meta.rememberSize !== false && meta.appId && sizes()[meta.appId] && !meta.explicitSize) wanted = sizes()[meta.appId];
        var step = (opened++ % 8) * 28;
        var r0 = fitRect({ width: Math.min(wanted[0], pw - 16), height: Math.min(wanted[1], ph - 16), left: 40 + step, top: 24 + step }, min, pw, ph);
        r0.left = clamp(40 + step, 0, Math.max(0, pw - r0.width));
        r0.top = clamp(24 + step, 0, Math.max(0, ph - r0.height));
        el.style.width = r0.width + 'px'; el.style.height = r0.height + 'px';
        el.style.left = r0.left + 'px'; el.style.top = r0.top + 'px';
        parent.appendChild(el);
        el.addEventListener('animationend', function () { el.classList.remove('is-opening'); }, { once: true });

        var api = null, maximized = false, minimized = false, closed = false, focused = false, restoreRect = null;

        function rect() { return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }; }
        function setRect(r) { el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; }

        function refit() {
            if (closed || maximized) return;
            var r = fitRect(rect(), min, parent.clientWidth, parent.clientHeight);
            setRect(r);
        }

        function topmost() {
            return registry.filter(function (o) { return !o.isMinimized(); }).sort(function (a, b) { return b.element.style.zIndex - a.element.style.zIndex; })[0];
        }

        function focus() {
            if (closed) return;
            if (minimized) restore();
            el.style.zIndex = ++zTop;
            if (!focused) {
                registry.forEach(function (o) { if (o !== api && o._setFocused) o._setFocused(false); });
                focused = true;
                el.classList.add('is-focused');
                emit('focus', api);
            }
        }
        function minimize() {
            if (closed || minimized) return;
            minimized = true;
            focused = false;
            el.classList.remove('is-focused');
            el.classList.add('is-minimized');
            emit('minimize', api);
            var next = registry.filter(function (o) { return o !== api && !o.isMinimized(); }).sort(function (a, b) { return b.element.style.zIndex - a.element.style.zIndex; })[0];
            if (next) next.focus();
        }
        function restore() {
            if (closed || !minimized) return;
            minimized = false;
            el.classList.remove('is-minimized');
            emit('restore', api);
        }
        function maximize() {
            if (closed || maximized) return;
            restoreRect = rect();
            maximized = true;
            el.classList.add('is-maximized');
            setRect({ left: 0, top: 0, width: parent.clientWidth, height: parent.clientHeight });
            el.style.width = '100%'; el.style.height = '100%';
            btnMax.innerHTML = icon('restore');
            btnMax.title = 'Restore';
            emit('resize', api);
        }
        function unmaximize(r) {
            if (!maximized) return;
            maximized = false;
            el.classList.remove('is-maximized');
            setRect(fitRect(r || restoreRect || { left: 40, top: 30, width: 700, height: 460 }, min, parent.clientWidth, parent.clientHeight));
            btnMax.innerHTML = icon('maximize');
            btnMax.title = 'Maximize';
            emit('resize', api);
        }
        function toggleMaximize() { maximized ? unmaximize() : maximize(); }

        function close(force) {
            if (closed) return Promise.resolve(true);
            if (!force && typeof api.beforeClose === 'function') {
                return Promise.resolve().then(function () { return api.beforeClose(); }).then(function (ok) {
                    if (ok === false) { focus(); return false; }
                    return close(true);
                });
            }
            closed = true;
            registry = registry.filter(function (o) { return o !== api; });
            try { if (onclose) onclose(); } catch (e) { console.error(e); }
            el.remove();
            emit('close', api);
            var next = topmost();
            if (next) next.focus();
            return Promise.resolve(true);
        }

        header.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || e.target.closest('.win-buttons')) return;
            focus();
            var startX = e.clientX, startY = e.clientY;
            var origin = rect();
            var prect = parent.getBoundingClientRect();
            var wasMax = maximized;
            try { header.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
            var moved = false;

            var move = function (ev) {
                var dx = ev.clientX - startX, dy = ev.clientY - startY;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                if (!moved) {
                    moved = true;
                    el.classList.add('is-dragging');
                    if (wasMax) {
                        var r = restoreRect || { width: 700, height: 460 };
                        var ratio = (startX - prect.left) / prect.width;
                        unmaximize({ left: 0, top: 0, width: r.width, height: r.height });
                        var now = rect();
                        origin = { left: clamp(startX - prect.left - now.width * ratio, 0, prect.width - now.width), top: 0, width: now.width, height: now.height };
                        startX = ev.clientX; startY = ev.clientY; dx = 0; dy = 0;
                    }
                }
                el.style.left = clamp(origin.left + dx, -(origin.width - 110), prect.width - 110) + 'px';
                el.style.top = clamp(origin.top + dy, 0, prect.height - 34) + 'px';
            };
            var up = function () {
                header.removeEventListener('pointermove', move);
                header.removeEventListener('pointerup', up);
                header.removeEventListener('pointercancel', up);
                el.classList.remove('is-dragging');
            };
            header.addEventListener('pointermove', move);
            header.addEventListener('pointerup', up);
            header.addEventListener('pointercancel', up);
        });
        header.addEventListener('dblclick', function (e) { if (!e.target.closest('.win-buttons')) toggleMaximize(); });

        el.querySelectorAll('.win-resize').forEach(function (handle) {
            handle.addEventListener('pointerdown', function (e) {
                if (e.button !== 0 || maximized) return;
                e.preventDefault();
                focus();
                var edge = handle.dataset.edge, start = rect(), sx = e.clientX, sy = e.clientY;
                var prect = parent.getBoundingClientRect();
                var minW = min[0], minH = min[1];
                try { handle.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
                el.classList.add('is-resizing');
                var move = function (ev) {
                    var dx = ev.clientX - sx, dy = ev.clientY - sy, r = Object.assign({}, start);
                    if (edge.indexOf('e') >= 0) r.width = clamp(start.width + dx, minW, prect.width - start.left);
                    if (edge.indexOf('s') >= 0) r.height = clamp(start.height + dy, minH, prect.height - start.top);
                    if (edge.indexOf('w') >= 0) { var nw = clamp(start.width - dx, minW, start.left + start.width); r.left = start.left + start.width - nw; r.width = nw; }
                    if (edge.indexOf('n') >= 0) { var nh = clamp(start.height - dy, minH, start.top + start.height); r.top = start.top + start.height - nh; r.height = nh; }
                    setRect(r);
                };
                var up = function () {
                    handle.removeEventListener('pointermove', move);
                    handle.removeEventListener('pointerup', up);
                    handle.removeEventListener('pointercancel', up);
                    el.classList.remove('is-resizing');
                    if (meta.rememberSize !== false) remember(meta.appId, el.offsetWidth, el.offsetHeight);
                    emit('resize', api);
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
            });
        });

        el.querySelector('.win-button-minimize').addEventListener('click', minimize);
        btnMax.addEventListener('click', toggleMaximize);
        el.querySelector('.win-button-close').addEventListener('click', function () { close(); });
        el.addEventListener('pointerdown', focus, true);

        api = {
            id: id,
            meta: meta,
            element: el,
            editContent: function (content) { body.innerHTML = content; },
            setIframe: function (url) {
                body.textContent = '';
                var f = document.createElement('iframe');
                f.src = url;
                f.title = titleEl.textContent;
                body.appendChild(f);
            },
            getBody: function () { return body; },
            getTitle: function () { return titleEl.textContent; },
            setTitle: function (t) { titleEl.textContent = t; el.setAttribute('aria-label', t); emit('title', api); },
            focus: focus, minimize: minimize, restore: restore,
            maximize: maximize, toggleMaximize: toggleMaximize, close: close, refit: refit,
            setSize: function (w, h) {
                if (maximized) return;
                var r = rect();
                setRect(fitRect({ left: r.left, top: r.top, width: w || r.width, height: h || r.height }, min, parent.clientWidth, parent.clientHeight));
            },
            isMinimized: function () { return minimized; },
            isMaximized: function () { return maximized; },
            isFocused: function () { return focused; },
            _setFocused: function (v) { focused = v; el.classList.toggle('is-focused', v); if (!v) emit('blur', api); },
            marginMinimizePos: marginMinimizePos
        };
        registry.push(api);
        emit('open', api);
        focus();
        if (meta.maximized) maximize();
        return api;
    }

    function refitAll() { registry.forEach(function (w) { w.refit(); }); }
    window.addEventListener('resize', refitAll);
    var watched = new WeakSet();
    function watch(parent) {
        if (typeof ResizeObserver === 'undefined' || watched.has(parent)) return;
        watched.add(parent);
        new ResizeObserver(refitAll).observe(parent);
    }

    window.addEventListener('blur', function () {
        setTimeout(function () {
            var active = document.activeElement;
            if (!active || active.tagName !== 'IFRAME') return;
            var owner = registry.find(function (w) { return w.element.contains(active); });
            if (owner) owner.focus();
        }, 0);
    });

    return ({
        new: function (title, size, parent, onclose, marginMinimizePos, meta) {
            var w = init(title, size, parent, onclose, marginMinimizePos, meta);
            watch(w.element.parentElement);
            return w;
        },
        list: function () { return registry.slice(); },
        refitAll: refitAll,
        fitRect: fitRect,
        onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; }
    });
})();
if (typeof module !== 'undefined') module.exports = __window;
