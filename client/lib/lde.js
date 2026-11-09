/**
 * __window  - the window manager.   __window.new(title, size, parent, onclose, marginMinimizePos, meta)
 * __desktop - the desktop surface (rubber-band selection).
 *
 * Same entry points as before. Rewritten on pointer events (mouse + touch + pen), with edge
 * resizing, maximise/restore, z-order + focus state, and change events the taskbar subscribes to.
 * Titles are set with textContent (the old code put them through innerHTML).
 */
var __window = (() => {
    var zTop = 20, seq = 0, opened = 0;
    var registry = [];
    var listeners = [];

    function emit(type, w) { listeners.slice().forEach(function (cb) { try { cb(type, w); } catch (e) { console.error(e); } }); }
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

    function icon(name) { return '<svg class="icon"><use href="/assets/images/icons.svg#' + name + '"/></svg>'; }

    function init(title, size, parent, onclose, marginMinimizePos, meta) {
        size = size || [800, 600];
        parent = parent || document.body;
        var id = ++seq;

        var el = document.createElement('div');
        el.className = 'window is-opening';
        el.setAttribute('role', 'dialog');
        el.innerHTML =
            '<div class="win-header">' +
              '<h5 class="win-title"></h5>' +
              '<div class="win-buttons">' +
                '<button type="button" class="win-button-minimize" title="Minimize" aria-label="Minimize">' + icon('minus') + '</button>' +
                '<button type="button" class="win-button-maximize" title="Maximize" aria-label="Maximize">' + icon('maximize') + '</button>' +
                '<button type="button" class="win-button-close" title="Close" aria-label="Close">' + icon('x') + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="win-body"></div>';
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

        // ---- geometry ----------------------------------------------------------------------------
        var pw = parent.clientWidth || innerWidth, ph = parent.clientHeight || innerHeight;
        var w = Math.min(size[0], pw - 16), h = Math.min(size[1], ph - 16);
        var step = (opened++ % 8) * 28;
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        el.style.left = clamp(40 + step, 0, Math.max(0, pw - w)) + 'px';
        el.style.top = clamp(24 + step, 0, Math.max(0, ph - h)) + 'px';
        parent.appendChild(el);
        el.addEventListener('animationend', function () { el.classList.remove('is-opening'); }, { once: true });

        var api = null, maximized = false, minimized = false, closed = false, focused = false, restoreRect = null;

        function rect() { return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }; }
        function setRect(r) { el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; }

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
            // hand focus to the next window that is still visible
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
            setRect(r || restoreRect || { left: 40, top: 30, width: 700, height: 460 });
            btnMax.innerHTML = icon('maximize');
            btnMax.title = 'Maximize';
            emit('resize', api);
        }
        function toggleMaximize() { maximized ? unmaximize() : maximize(); }

        /** Resolves true once closed, false if the app vetoed it (api.beforeClose() -> false, may be async). */
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
            var next = registry.filter(function (o) { return !o.isMinimized(); }).sort(function (a, b) { return b.element.style.zIndex - a.element.style.zIndex; })[0];
            if (next) next.focus();
            return Promise.resolve(true);
        }

        // ---- dragging --------------------------------------------------------------------------------
        header.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || e.target.closest('.win-buttons')) return;
            focus();
            var startX = e.clientX, startY = e.clientY;
            var origin = rect();
            var prect = parent.getBoundingClientRect();
            var wasMax = maximized;
            header.setPointerCapture(e.pointerId);
            var moved = false;

            var move = function (ev) {
                var dx = ev.clientX - startX, dy = ev.clientY - startY;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                if (!moved) {
                    moved = true;
                    el.classList.add('is-dragging');
                    if (wasMax) { // grab a maximised window: restore it under the pointer
                        var r = restoreRect || { width: 700, height: 460 };
                        var ratio = (startX - prect.left) / prect.width;
                        unmaximize({ left: 0, top: 0, width: r.width, height: r.height });
                        origin = { left: clamp(startX - prect.left - r.width * ratio, 0, prect.width - r.width), top: 0, width: r.width, height: r.height };
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

        // ---- resizing ---------------------------------------------------------------------------------
        el.querySelectorAll('.win-resize').forEach(function (handle) {
            handle.addEventListener('pointerdown', function (e) {
                if (e.button !== 0 || maximized) return;
                e.preventDefault();
                focus();
                var edge = handle.dataset.edge, start = rect(), sx = e.clientX, sy = e.clientY;
                var prect = parent.getBoundingClientRect();
                var minW = 240, minH = 140;
                handle.setPointerCapture(e.pointerId);
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
                    emit('resize', api);
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
            });
        });

        // ---- buttons / focus ---------------------------------------------------------------------------
        el.querySelector('.win-button-minimize').addEventListener('click', minimize);
        btnMax.addEventListener('click', toggleMaximize);
        el.querySelector('.win-button-close').addEventListener('click', function () { close(); });
        el.addEventListener('pointerdown', focus, true);

        api = {
            id: id,
            meta: meta || {},
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
            maximize: maximize, toggleMaximize: toggleMaximize, close: close,
            isMinimized: function () { return minimized; },
            isMaximized: function () { return maximized; },
            isFocused: function () { return focused; },
            _setFocused: function (v) { focused = v; el.classList.toggle('is-focused', v); if (!v) emit('blur', api); },
            marginMinimizePos: marginMinimizePos
        };
        registry.push(api);
        emit('open', api);
        focus();
        return api;
    }

    // keep windows reachable when the browser window shrinks
    window.addEventListener('resize', function () {
        registry.forEach(function (w) {
            var el = w.element, parent = el.parentElement;
            if (!parent || w.isMaximized()) return;
            el.style.left = clamp(el.offsetLeft, -(el.offsetWidth - 110), parent.clientWidth - 110) + 'px';
            el.style.top = clamp(el.offsetTop, 0, Math.max(0, parent.clientHeight - 34)) + 'px';
        });
    });

    return ({
        new: init,
        list: function () { return registry.slice(); },
        onChange: function (cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; }
    });
})();

var __desktop = (() => {
    function init() {
        return ({
            /**
             * Rubber-band selection on the empty desktop. `div` is the rectangle element; `surface`
             * the element that receives the drag. onRect(rect, final) is called while dragging.
             */
            setSelectionRect: function (div, surface, onRect) {
                surface.addEventListener('pointerdown', function (e) {
                    if (e.button !== 0 || e.target !== surface) return;
                    var box = surface.getBoundingClientRect();
                    var sx = e.clientX - box.left, sy = e.clientY - box.top;
                    surface.setPointerCapture(e.pointerId);
                    div.style.display = 'block';
                    var move = function (ev) {
                        var x = Math.max(0, Math.min(ev.clientX - box.left, box.width));
                        var y = Math.max(0, Math.min(ev.clientY - box.top, box.height));
                        var r = { left: Math.min(sx, x), top: Math.min(sy, y), width: Math.abs(x - sx), height: Math.abs(y - sy) };
                        div.style.left = r.left + 'px'; div.style.top = r.top + 'px';
                        div.style.width = r.width + 'px'; div.style.height = r.height + 'px';
                        if (onRect) onRect(r, false);
                    };
                    var up = function (ev) {
                        surface.removeEventListener('pointermove', move);
                        surface.removeEventListener('pointerup', up);
                        surface.removeEventListener('pointercancel', up);
                        div.style.display = 'none';
                        if (onRect) onRect(null, true);
                    };
                    surface.addEventListener('pointermove', move);
                    surface.addEventListener('pointerup', up);
                    surface.addEventListener('pointercancel', up);
                });
            }
        });
    }
    return ({ new: init });
})();
