var __select = (() => {
    var THRESHOLD = 4, EDGE = 28, MAX_SPEED = 22;

    function rectOf(a, b) {
        return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    }
    function intersects(r, o) {
        return !(o.right <= r.left || o.left >= r.left + r.width || o.bottom <= r.top || o.top >= r.top + r.height);
    }
    function modeOf(e) { return (e.ctrlKey || e.metaKey) ? 'toggle' : e.shiftKey ? 'add' : 'replace'; }

    function combine(initial, hits, mode) {
        var out = new Set(mode === 'replace' ? [] : initial);
        hits.forEach(function (k) {
            if (mode === 'toggle' && initial.has(k)) out.delete(k); else out.add(k);
        });
        return out;
    }

    function attach(opts) {
        var surface = opts.surface, itemSelector = opts.itemSelector, root = opts.itemsRoot || surface;
        var band = document.createElement('div');
        band.className = 'sel-rect';
        band.hidden = true;
        band.setAttribute('aria-hidden', 'true');
        var state = null, rafId = 0, destroyed = false;

        function isBackground(e) {
            if (opts.isBackground) return opts.isBackground(e);
            var t = e.target;
            return !t.closest(itemSelector) && !t.closest('button, input, select, textarea, a, [contenteditable]');
        }
        function origin() {
            var box = surface.getBoundingClientRect();
            return { x: box.left + surface.clientLeft - surface.scrollLeft, y: box.top + surface.clientTop - surface.scrollTop, box: box };
        }

        function down(e) {
            if (destroyed || e.button !== 0 || e.pointerType === 'touch' || !isBackground(e)) return;
            if (opts.canStart && !opts.canStart(e)) return;
            e.preventDefault();
            if (!surface.contains(band)) surface.appendChild(band);
            var o = origin();
            state = { id: e.pointerId, sx: e.clientX - o.x, sy: e.clientY - o.y, cx: e.clientX, cy: e.clientY, mode: modeOf(e), moved: false };
            try { surface.setPointerCapture(e.pointerId); } catch (x) {}
            if (opts.onStart) opts.onStart(e, state.mode);
        }

        function hitsFor(rect) {
            var o = origin(), out = [];
            root.querySelectorAll(itemSelector).forEach(function (el) {
                var b = el.getBoundingClientRect();
                if (intersects(rect, { left: b.left - o.x, right: b.right - o.x, top: b.top - o.y, bottom: b.bottom - o.y })) out.push(el);
            });
            return out;
        }

        function update() {
            if (!state) return;
            var o = origin();
            var w = Math.max(surface.scrollWidth, surface.clientWidth), h = Math.max(surface.scrollHeight, surface.clientHeight);
            var x = Math.max(0, Math.min(state.cx - o.x, w)), y = Math.max(0, Math.min(state.cy - o.y, h));
            var r = rectOf({ x: state.sx, y: state.sy }, { x: x, y: y });
            band.style.left = r.left + 'px'; band.style.top = r.top + 'px';
            band.style.width = r.width + 'px'; band.style.height = r.height + 'px';
            if (opts.onChange) opts.onChange(hitsFor(r), state.mode, false);
        }

        function autoscroll() {
            rafId = 0;
            if (!state || !state.moved || opts.autoscroll === false) return;
            var box = surface.getBoundingClientRect(), dx = 0, dy = 0;
            if (state.cy < box.top + EDGE) dy = -Math.ceil(MAX_SPEED * Math.min(1, (box.top + EDGE - state.cy) / EDGE));
            else if (state.cy > box.bottom - EDGE) dy = Math.ceil(MAX_SPEED * Math.min(1, (state.cy - (box.bottom - EDGE)) / EDGE));
            if (state.cx < box.left + EDGE) dx = -Math.ceil(MAX_SPEED * Math.min(1, (box.left + EDGE - state.cx) / EDGE));
            else if (state.cx > box.right - EDGE) dx = Math.ceil(MAX_SPEED * Math.min(1, (state.cx - (box.right - EDGE)) / EDGE));
            if (!dx && !dy) return;
            var bx = surface.scrollLeft, by = surface.scrollTop;
            surface.scrollLeft += dx; surface.scrollTop += dy;
            if (surface.scrollLeft !== bx || surface.scrollTop !== by) update();
            rafId = requestAnimationFrame(autoscroll);
        }

        function move(e) {
            if (!state || e.pointerId !== state.id) return;
            state.cx = e.clientX; state.cy = e.clientY;
            if (!state.moved) {
                var o = origin();
                if (Math.abs(e.clientX - o.x - state.sx) + Math.abs(e.clientY - o.y - state.sy) < THRESHOLD) return;
                state.moved = true;
                band.hidden = false;
            }
            update();
            if (!rafId) rafId = requestAnimationFrame(autoscroll);
        }

        function finish(e, cancelled) {
            if (!state || (e && e.pointerId !== state.id)) return;
            var s = state;
            state = null;
            cancelAnimationFrame(rafId); rafId = 0;
            band.hidden = true;
            try { surface.releasePointerCapture(s.id); } catch (x) { /* already released */ }
            if (s.moved) {                              // swallow the click this gesture is about to produce
                var stop = function (ev) { ev.stopPropagation(); ev.preventDefault(); };
                surface.addEventListener('click', stop, { capture: true, once: true });
                setTimeout(function () { surface.removeEventListener('click', stop, true); }, 0);
            }
            if (opts.onChange && s.moved && !cancelled) opts.onChange(hitsFor(rectFromBand()), s.mode, true);
            if (opts.onEnd) opts.onEnd(s.moved && !cancelled, s.mode);
        }
        function rectFromBand() {
            return { left: parseFloat(band.style.left) || 0, top: parseFloat(band.style.top) || 0, width: parseFloat(band.style.width) || 0, height: parseFloat(band.style.height) || 0 };
        }
        function keydown(e) { if (state && e.key === 'Escape') { e.stopPropagation(); finish(null, true); } }

        surface.addEventListener('pointerdown', down);
        surface.addEventListener('pointermove', move);
        surface.addEventListener('pointerup', function (e) { finish(e, false); });
        surface.addEventListener('pointercancel', function (e) { finish(e, true); });
        document.addEventListener('keydown', keydown, true);

        return {
            band: band,
            isActive: function () { return !!state && state.moved; },
            destroy: function () { destroyed = true; document.removeEventListener('keydown', keydown, true); band.remove(); }
        };
    }

    return ({ attach: attach, rectOf: rectOf, intersects: intersects, combine: combine, modeOf: modeOf });
})();
if (typeof module !== 'undefined') module.exports = __select;
