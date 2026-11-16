/**
 * Desktop icons.
 *
 * The desktop shows what is in the user's /desktop folder: `.shc` files are shortcuts (name / icon / application come from the
 * XML inside), everything else is a plain file or folder. Where each icon sits is saved on the server (a grid cell per file
 * name), so the arrangement follows the user to every browser.
 *
 * Interactions: click / Ctrl-click / Shift-click select, dragging on empty space draws the selection rectangle, dragging an icon
 * moves it (all selected icons move together, snapping to the grid; dropping on a folder moves the files into it), double-click or
 * Enter opens, F2 renames, Delete deletes, arrows move the selection, files dragged in from the OS are uploaded,
 * files dragged from an Explorer window are moved here.
 */
(function () {
    var auth = __auth.getInstance();
    var ui = __ui, esc = __ui.esc;
    document.desktopState = document.desktopState || {};

    var IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1, bmp: 1 };
    var AUDIO_EXT = { mp3: 1, ogg: 1, wav: 1, flac: 1, m4a: 1, aac: 1, opus: 1 };
    var CODE_EXT = { js: 1, ts: 1, py: 1, c: 1, h: 1, cpp: 1, java: 1, json: 1, html: 1, css: 1, sh: 1, md: 1, txt: 1, xml: 1, yml: 1, yaml: 1 };

    function baseName(p) { return p.slice(p.lastIndexOf('/') + 1); }
    function cssNum(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return isFinite(v) ? v : fallback; }

    document.desktopState.createIcons = function (ctx) {
        var surface = ctx.surface, h = ctx.handle, apps = ctx.apps;
        var tabId = (window.__theme && __theme.tabId) || '';
        var items = [], byPath = {}, order = [], selection = new Set(), anchor = null;
        var layout = { seeded: false, items: {} }, layoutVersion = '';
        var cells = {}, grid = { rows: 1, cols: 1 }, dims = { w: 92, h: 96, gap: 6, pad: 12 };
        var cellsEl = document.createElement('div'), hint = document.createElement('div');
        cellsEl.className = 'de-cells'; hint.className = 'de-cell-hint'; hint.hidden = true;
        surface.appendChild(cellsEl);
        var pending = {};   // placements chosen by the user but not saved yet: they must survive a refresh that arrives first
        function put(name, cell) { layout.items[name] = cell; pending[name] = cell; }
        var saveTimer = 0, refreshing = null, refreshAgain = false, dragState = null, renaming = false, seedTried = false;

        function fail(err) { ui.toast(ui.errorText(err), 'error'); }

        /* ------------------------------------------------------------------------------------ model */
        function toItem(entry, shortcutInfo) {
            var it = { path: entry.path, file: entry.name, type: entry.type, ext: entry.ext || '', size: entry.size };
            if (entry.type === 'folder') it.kind = 'folder';
            else if (it.ext === 'shc') {
                it.kind = 'shortcut';
                if (shortcutInfo && shortcutInfo.shortcut) { it.shortcut = shortcutInfo.shortcut; it.label = shortcutInfo.shortcut.name; it.warnings = shortcutInfo.warnings || []; }
                else { it.error = (shortcutInfo && shortcutInfo.error) || 'unreadable'; it.detail = shortcutInfo && shortcutInfo.detail; it.label = it.file.replace(/\.shc$/i, ''); }
            } else it.kind = 'file';
            if (!it.label) it.label = it.file;
            return it;
        }
        function setSnapshot(snap) {
            var info = {};
            (snap.shortcuts || []).forEach(function (s) { info[s.path] = s; });
            items = (snap.content || []).filter(function (e) { return !e.hidden; }).map(function (e) { return toItem(e, info[e.path]); });
            var rank = { folder: 0, shortcut: 1, file: 2 };
            items.sort(function (a, b) { return rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }); });
            byPath = {}; items.forEach(function (it) { byPath[it.path] = it; });
            order = items.map(function (it) { return it.path; });
            layout = snap.layout || layout; layoutVersion = snap.layout_version || '';
            Object.keys(pending).forEach(function (n) { layout.items[n] = pending[n]; });   // the server has not heard of these yet
            selection.forEach(function (p) { if (!byPath[p]) selection.delete(p); });
        }

        /* ------------------------------------------------------------------------------------ rendering */
        function measure() {
            dims = { w: cssNum('--icon-cell-w', 92), h: cssNum('--icon-cell-h', 96), gap: cssNum('--icon-gap', 6), pad: cssNum('--icon-pad', 12) };
            grid.rows = Math.max(1, Math.floor((surface.clientHeight - 2 * dims.pad + dims.gap) / (dims.h + dims.gap)));
            grid.cols = Math.max(1, Math.floor((surface.clientWidth - 2 * dims.pad + dims.gap) / (dims.w + dims.gap)));
        }
        function pos(cell) { return { left: dims.pad + cell.c * (dims.w + dims.gap), top: dims.pad + cell.r * (dims.h + dims.gap) }; }

        function iconNode(it) {
            var box = document.createElement('span'); box.className = 'de-icon__img';
            if (it.kind === 'shortcut') {
                var ic = __shortcuts.iconOf(it.shortcut || { open: '', icon: '' }, ctx.registry());
                if (it.error) box.innerHTML = ui.icon('alert');
                else if (ic.src) { var im = new Image(); im.alt = ''; im.loading = 'lazy'; im.draggable = false; im.src = ic.src; im.onerror = function () { box.innerHTML = ui.icon('file'); }; box.appendChild(im); }
                else box.innerHTML = ui.icon(ic.name);
            } else if (it.kind === 'folder') {
                var f = new Image(); f.alt = ''; f.draggable = false; f.src = '/assets/images/default_folder.png'; box.appendChild(f);
            } else if (IMAGE_EXT[it.ext]) {
                var t = new Image(); t.alt = ''; t.loading = 'lazy'; t.draggable = false; t.src = auth.fileUrl(it.path);
                t.onerror = function () { box.textContent = ''; box.innerHTML = ui.icon('image'); };
                box.appendChild(t);
            } else if (AUDIO_EXT[it.ext]) box.innerHTML = ui.icon('music');
            else if (CODE_EXT[it.ext]) box.innerHTML = ui.icon('code');
            else { var d = new Image(); d.alt = ''; d.draggable = false; d.src = '/assets/images/default_file.png'; box.appendChild(d); }
            return box;
        }

        function render() {
            // rebuilding the icons destroys the element that had keyboard focus (a clicked icon): without this, Ctrl+A / Delete / F2 /
            // arrows silently stopped working after any refresh (e.g. the one that follows the first seeding)
            var hadFocus = surface.contains(document.activeElement) && document.activeElement !== surface;
            measure();
            var placed = __grid.place(order.map(baseName), layout.items, grid.rows, grid.cols);
            cells = placed.cells;
            cellsEl.textContent = '';
            var maxC = 0;
            items.forEach(function (it) {
                var cell = cells[it.file]; maxC = Math.max(maxC, cell.c);
                var p = pos(cell);
                var el = document.createElement('div');
                el.className = 'de-icon is-' + it.kind + (it.error ? ' is-broken' : '') + (selection.has(it.path) ? ' is-selected' : '');
                el.dataset.path = it.path; el.dataset.kind = it.kind;
                el.setAttribute('role', 'listitem'); el.setAttribute('aria-label', it.label); el.tabIndex = -1;
                el.style.left = p.left + 'px'; el.style.top = p.top + 'px';
                el.title = it.error ? it.label + ' — this shortcut is broken (' + it.error.replace(/_/g, ' ') + ')' : (it.shortcut && it.shortcut.comment ? it.label + '\n' + it.shortcut.comment : it.label);
                el.appendChild(iconNode(it));
                var name = document.createElement('span'); name.className = 'de-icon__name'; name.textContent = it.label; el.appendChild(name);
                cellsEl.appendChild(el);
            });
            cellsEl.style.minWidth = (dims.pad * 2 + (maxC + 1) * (dims.w + dims.gap)) + 'px';
            cellsEl.appendChild(hint);
            if (hadFocus && !renaming) surface.focus({ preventScroll: true });
            if (placed.fresh.length) {       // icons the layout had never seen: remember where they went
                placed.fresh.forEach(function (n) { put(n, cells[n]); });
                saveLayoutSoon();
            }
        }
        function paintSelection() {
            cellsEl.querySelectorAll('.de-icon').forEach(function (el) { el.classList.toggle('is-selected', selection.has(el.dataset.path)); });
        }

        /* ------------------------------------------------------------------------------------ server state */
        function refresh() {
            if (refreshing) { refreshAgain = true; return refreshing; }
            refreshing = h.fetch('snapshot').then(function (snap) {
                setSnapshot(snap);
                if (layout.seeded || seedTried) return;
                seedTried = true;      // once per page load: a failing seed must not toast on every refresh, nor stop the desktop rendering
                return seed(false).then(function () { return h.fetch('snapshot').then(setSnapshot); }, fail);
            }).then(function () { if (!renaming) render(); }, fail).then(function () {
                refreshing = null;
                if (refreshAgain) { refreshAgain = false; return refresh(); }
            });
            return refreshing;
        }
        function seed(force) {
            return h.update('shortcuts_seed', { items: __shortcuts.defaults(ctx.registry()), force: !!force, origin: tabId });
        }
        function saveLayoutSoon() {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(function () {
                var names = {}; items.forEach(function (it) { names[it.file] = 1; });
                var keep = {}; Object.keys(layout.items).forEach(function (n) { if (names[n]) keep[n] = layout.items[n]; });   // forget deleted files
                h.update('layout_save', { layout: { seeded: layout.seeded, items: keep }, base_version: layoutVersion, origin: tabId }).then(function (r) { layoutVersion = r.version; layout.items = keep; Object.keys(keep).forEach(function (n) { if (pending[n] && keep[n].c === pending[n].c && keep[n].r === pending[n].r) delete pending[n]; }); }, function (err) {
                    if (err && err.code === 'conflict') { layoutVersion = err.details.version; saveLayoutSoon(); } else fail(err);
                });
            }, 350);
        }

        /* ------------------------------------------------------------------------------------ actions */
        function selected() { return order.filter(function (p) { return selection.has(p); }).map(function (p) { return byPath[p]; }); }
        function setSelection(list, keepAnchor) { selection = new Set(list); if (!keepAnchor) anchor = list.length ? list[list.length - 1] : null; paintSelection(); }

        function openItem(it) {
            if (it.kind === 'folder') return apps.open('explorer', { path: it.path }).catch(fail);
            if (it.kind === 'shortcut') {
                if (it.error) { fail({ code: it.error, details: { detail: 'This shortcut is broken. ' + (it.detail || '') } }); return __shortcuts.openProperties(it.path); }
                return __shortcuts.launch(it.shortcut).catch(fail);
            }
            return apps.openPath(it.path, 'file').catch(fail);
        }
        function openSelected() { selected().forEach(openItem); }

        function remove(list) {
            if (!list.length) return;
            ui.confirm({ title: 'Delete', message: list.length === 1 ? 'Delete “' + list[0].label + '”? This cannot be undone.' : 'Delete these ' + list.length + ' items? This cannot be undone.', confirmText: 'Delete', danger: true }).then(function (yes) {
                if (yes) h.update('delete', { paths: list.map(function (i) { return i.path; }) }).then(function () { setSelection([]); }, fail);
            });
        }

        function rename(it) {
            var el = cellsEl.querySelector('.de-icon[data-path="' + CSS.escape(it.path) + '"] .de-icon__name');
            if (!el) return;
            renaming = true;
            var input = document.createElement('input'); input.value = it.kind === 'shortcut' ? it.label : it.file; input.maxLength = 255; input.setAttribute('aria-label', 'Name');
            el.textContent = ''; el.appendChild(input);
            input.focus();
            if (it.kind === 'file' && it.ext) input.setSelectionRange(0, it.file.length - it.ext.length - 1); else input.select();
            var done = false;
            function finish(commit) {
                if (done) return; done = true; renaming = false;
                var v = input.value.trim();
                if (!commit || !v || v === (it.kind === 'shortcut' ? it.label : it.file)) { render(); return; }
                var job = it.kind === 'shortcut' && it.shortcut
                    ? h.update('shortcut_save', { path: it.path, shortcut: Object.assign({}, it.shortcut, { name: v }), origin: tabId })   // a shortcut's name is inside the file
                    : h.update('rename', { path: it.path, name: v }).then(function (r) { if (layout.items[it.file]) { put(v, layout.items[it.file]); delete layout.items[it.file]; delete pending[it.file]; saveLayoutSoon(); } return r; });
                job.then(function () { return refresh(); }, function (err) { fail(err); render(); });
            }
            input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
            input.addEventListener('blur', function () { finish(true); });
            input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        }

        function properties(it) {
            if (it.kind === 'shortcut') return __shortcuts.openProperties(it.path);
            return h.fetch('stat', { path: it.path }).then(function (r) { __props.openFileInfo(r.stat); }, fail);
        }

        function create(kind) {
            ui.prompt({ title: kind === 'mkdir' ? 'New folder' : 'New file', label: 'Name', value: kind === 'mkdir' ? 'New folder' : 'New file.txt', selectBase: kind === 'mkfile',
                validate: function (v) { return !v ? 'Required' : /[\/\\]/.test(v) ? 'A name cannot contain / or \\' : ''; } }).then(function (name) {
                if (!name) return;
                h.update(kind, { path: '/desktop', name: name }).then(function (r) { return refresh().then(function () { setSelection([r.path]); }); }, fail);
            });
        }

        function arrange() {
            var arranged = __grid.arrange(order.map(baseName), grid.rows);
            layout.items = {}; Object.keys(arranged).forEach(function (n) { put(n, arranged[n]); });
            render(); saveLayoutSoon();
        }

        /* ------------------------------------------------------------------------------------ menus */
        function itemMenu(list, x, y) {
            var one = list.length === 1 ? list[0] : null;
            ui.menu([
                { label: list.length > 1 ? 'Open ' + list.length + ' items' : 'Open', icon: 'play', kbd: 'Enter', action: function () { list.forEach(openItem); } },
                one && one.kind === 'file' ? { label: 'Open with Code', icon: 'code', action: function () { apps.open('code', { path: one.path }).catch(fail); } } : null,
                one && one.kind === 'shortcut' ? { label: 'Edit shortcut XML in Code', icon: 'code', action: function () { apps.open('code', { path: one.path }).catch(fail); } } : null,
                { label: 'Show in Explorer', icon: 'folder', disabled: !one, action: function () { apps.open('explorer', { path: one.kind === 'folder' ? one.path : '/desktop' }).catch(fail); } },
                { separator: true },
                { label: 'Rename', icon: 'pencil', kbd: 'F2', disabled: !one, action: function () { rename(one); } },
                { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, action: function () { remove(list); } },
                { separator: true },
                { label: 'Properties', icon: 'info', disabled: !one, action: function () { properties(one); } }
            ].filter(Boolean), x, y);
        }
        function backgroundMenu(x, y) {
            ui.menu([
                { label: 'New', icon: 'plus', submenu: [
                    { label: 'Shortcut…', icon: 'link', action: function () { __shortcuts.openCreate('/desktop').catch(fail); } },
                    { label: 'Folder', icon: 'folder-plus', action: function () { create('mkdir'); } },
                    { label: 'Text file', icon: 'file-plus', action: function () { create('mkfile'); } }] },
                { separator: true },
                { label: 'Arrange icons', icon: 'grid', action: arrange },
                { label: 'Refresh', icon: 'refresh', kbd: 'F5', action: refresh },
                { label: 'Restore default shortcuts', icon: 'home', action: function () { seed(true).then(refresh, fail); } },
                { separator: true },
                { label: 'Open desktop folder', icon: 'folder', action: function () { apps.open('explorer', { path: '/desktop' }).catch(fail); } },
                { label: 'Personalize…', icon: 'palette', action: function () { document.desktopState.openAppearance(); } }
            ], x, y);
        }
        surface.addEventListener('contextmenu', function (e) {
            if (renaming) return;
            e.preventDefault();
            var el = e.target.closest('.de-icon');
            if (el) {
                if (!selection.has(el.dataset.path)) setSelection([el.dataset.path]);
                itemMenu(selected(), e.clientX, e.clientY);
            } else { setSelection([]); backgroundMenu(e.clientX, e.clientY); }
        });
        // touch: long-press opens the same menu
        (function () {
            var timer = 0, sx = 0, sy = 0;
            surface.addEventListener('pointerdown', function (e) {
                if (e.pointerType !== 'touch') return;
                sx = e.clientX; sy = e.clientY;
                timer = setTimeout(function () { surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: sx, clientY: sy })); }, 600);
            });
            ['pointerup', 'pointercancel', 'pointermove'].forEach(function (t) { surface.addEventListener(t, function (e) { if (t !== 'pointermove' || Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) clearTimeout(timer); }); });
        })();

        /* ------------------------------------------------------------------------------------ click selection / open */
        surface.addEventListener('click', function (e) {
            if (renaming) return;
            var el = e.target.closest('.de-icon');
            if (!el) { if (!(e.ctrlKey || e.metaKey || e.shiftKey)) setSelection([]); return; }
            var p = el.dataset.path;
            if (e.ctrlKey || e.metaKey) { var s = new Set(selection); s.has(p) ? s.delete(p) : s.add(p); selection = s; anchor = p; paintSelection(); }
            else if (e.shiftKey && anchor && byPath[anchor]) {
                var a = order.indexOf(anchor), b = order.indexOf(p);
                setSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1), true);
            } else setSelection([p]);
        });
        surface.addEventListener('dblclick', function (e) {
            var el = e.target.closest('.de-icon');
            if (el && byPath[el.dataset.path]) openItem(byPath[el.dataset.path]);
        });
        // a single tap opens on touch screens (no double-tap there)
        surface.addEventListener('pointerup', function (e) {
            if (e.pointerType !== 'touch') return;
            var el = e.target.closest('.de-icon');
            if (el && byPath[el.dataset.path] && !renaming) openItem(byPath[el.dataset.path]);
        });

        /* ------------------------------------------------------------------------------------ rubber band */
        var initialSelection = null;
        __select.attach({
            surface: surface, itemSelector: '.de-icon', itemsRoot: cellsEl,
            isBackground: function (e) { return !e.target.closest('.de-icon') && !renaming; },
            onStart: function () { initialSelection = new Set(selection); surface.focus({ preventScroll: true }); },
            onChange: function (hits, mode) {
                var hitSet = new Set(hits.map(function (el) { return el.dataset.path; }));
                selection = __select.combine(initialSelection, hitSet, mode);
                paintSelection();
            }
        });

        /* ------------------------------------------------------------------------------------ drag to reorder / move into folder */
        surface.addEventListener('pointerdown', function (e) {
            var el = e.target.closest('.de-icon');
            if (!el || e.button !== 0 || e.pointerType === 'touch' || renaming) return;
            var p = el.dataset.path;
            if (!selection.has(p) && !(e.ctrlKey || e.metaKey || e.shiftKey)) setSelection([p]);
            if (!selection.has(p)) return;     // ctrl/shift press on an unselected icon: that is a click, not a drag
            // NO pointer capture yet: once an element captures the pointer, the click that follows is retargeted to it (the
            // surface), and a plain click on an icon would look like a click on empty space. Capture only when a real drag starts.
            dragState = { id: e.pointerId, primary: p, x: e.clientX, y: e.clientY, moved: false, ghost: null, target: null, into: null };
        });
        surface.addEventListener('pointermove', function (e) {
            var d = dragState; if (!d || e.pointerId !== d.id) return;
            var dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (!d.moved) {
                if (Math.abs(dx) + Math.abs(dy) < 5) return;
                d.moved = true; startGhost(d);
                try { surface.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
            }
            d.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
            var under = document.elementFromPoint(e.clientX, e.clientY);       // the ghost ignores the pointer, so this is the icon / window below
            var overIcon = under && under.closest && under.closest('.de-icon');
            cellsEl.querySelectorAll('.de-icon.is-drop').forEach(function (n) { n.classList.remove('is-drop'); });
            d.into = null;
            if (overIcon && overIcon.dataset.kind === 'folder' && !selection.has(overIcon.dataset.path)) { overIcon.classList.add('is-drop'); d.into = overIcon.dataset.path; hint.hidden = true; return; }
            if (under && !surface.contains(under)) { hint.hidden = true; d.target = null; return; }   // over a window / the taskbar: no snapping
            var box = cellsEl.getBoundingClientRect();
            var c = __grid.cellAt(e.clientX - box.left - dims.w / 2 + dims.pad, e.clientY - box.top - dims.h / 2 + dims.pad, dims.w + dims.gap, dims.h + dims.gap, dims.pad);
            c.r = Math.min(c.r, grid.rows - 1);
            var moving = {}, fixed = {};
            items.forEach(function (it) { (selection.has(it.path) ? moving : fixed)[it.file] = cells[it.file]; });
            d.target = __grid.drop(moving, baseName(d.primary), c, fixed, grid.rows);
            var first = pos(d.target[baseName(d.primary)]);
            hint.hidden = false; hint.style.left = first.left + 'px'; hint.style.top = first.top + 'px'; hint.style.width = dims.w + 'px'; hint.style.height = dims.h + 'px';
        });
        function startGhost(d) {
            var ghost = document.createElement('div'); ghost.className = 'de-ghost';
            var base = cellsEl.querySelector('.de-icon[data-path="' + CSS.escape(d.primary) + '"]').getBoundingClientRect();
            ghost.style.left = base.left + 'px'; ghost.style.top = base.top + 'px';
            cellsEl.querySelectorAll('.de-icon.is-selected').forEach(function (n) {
                var b = n.getBoundingClientRect(), c = n.cloneNode(true);
                c.style.left = (b.left - base.left) + 'px'; c.style.top = (b.top - base.top) + 'px'; c.classList.remove('is-selected');
                ghost.appendChild(c); n.style.opacity = '.35';
            });
            document.body.appendChild(ghost); d.ghost = ghost;
        }
        function endDrag(commit) {
            var d = dragState; dragState = null; if (!d) return;
            try { surface.releasePointerCapture(d.id); } catch (x) { /* released */ }
            if (!d.moved) return;
            if (d.ghost) d.ghost.remove();
            hint.hidden = true;
            cellsEl.querySelectorAll('.de-icon').forEach(function (n) { n.style.opacity = ''; n.classList.remove('is-drop'); });
            var swallow = function (ev) { ev.stopPropagation(); };    // the click that ends a drag must not change the selection
            surface.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(function () { surface.removeEventListener('click', swallow, true); }, 0);
            if (!commit) return;
            if (d.into) {
                h.update('move', { paths: selected().map(function (i) { return i.path; }), dest: d.into }).then(function () { setSelection([]); }, fail);
            } else if (d.target) {
                Object.keys(d.target).forEach(function (n) { put(n, d.target[n]); });
                render(); saveLayoutSoon();
            }
        }
        surface.addEventListener('pointerup', function (e) { if (dragState && e.pointerId === dragState.id) endDrag(true); });
        surface.addEventListener('pointercancel', function () { endDrag(false); });
        document.addEventListener('keydown', function (e) { if (dragState && dragState.moved && e.key === 'Escape') endDrag(false); }, true);
        surface.addEventListener('dragstart', function (e) { e.preventDefault(); });

        /* ------------------------------------------------------------------------------------ files dropped from the OS / an Explorer window */
        function hasFiles(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
        function hasPaths(e) { return e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'application/x-xp-paths') >= 0; }
        surface.addEventListener('dragover', function (e) {
            if (!hasFiles(e) && !hasPaths(e)) return;
            e.preventDefault(); e.dataTransfer.dropEffect = hasPaths(e) ? (e.ctrlKey ? 'copy' : 'move') : 'copy';
            var f = e.target.closest('.de-icon[data-kind="folder"]');
            cellsEl.querySelectorAll('.de-icon.is-drop').forEach(function (n) { if (n !== f) n.classList.remove('is-drop'); });
            if (f) f.classList.add('is-drop');
        });
        surface.addEventListener('dragleave', function (e) { if (!surface.contains(e.relatedTarget)) cellsEl.querySelectorAll('.de-icon.is-drop').forEach(function (n) { n.classList.remove('is-drop'); }); });
        surface.addEventListener('drop', function (e) {
            if (!hasFiles(e) && !hasPaths(e)) return;
            e.preventDefault();
            cellsEl.querySelectorAll('.de-icon.is-drop').forEach(function (n) { n.classList.remove('is-drop'); });
            var folder = e.target.closest('.de-icon[data-kind="folder"]');
            var dest = folder ? folder.dataset.path : '/desktop';
            var box = cellsEl.getBoundingClientRect();
            var at = __grid.cellAt(e.clientX - box.left - dims.w / 2 + dims.pad, e.clientY - box.top - dims.h / 2 + dims.pad, dims.w + dims.gap, dims.h + dims.gap, dims.pad);
            at.r = Math.min(at.r, grid.rows - 1);
            if (hasPaths(e)) {
                var paths = []; try { paths = JSON.parse(e.dataTransfer.getData('application/x-xp-paths')); } catch (x) { return; }
                if (!Array.isArray(paths) || !paths.length) return;
                if (!folder) paths.forEach(function (p, i) { put(baseName(p), { c: at.c + Math.floor(i / grid.rows), r: (at.r + i) % grid.rows }); });
                h.update(e.ctrlKey ? 'copy' : 'move', { paths: paths, dest: dest }).then(function () { saveLayoutSoon(); }, fail);
            } else {
                Array.prototype.forEach.call(e.dataTransfer.files, function (f, i) {
                    if (!folder) put(f.name, { c: at.c + Math.floor(i / grid.rows), r: (at.r + i) % grid.rows });
                    auth.upload(dest + '/' + f.name, f).then(function () { ui.toast('Uploaded ' + f.name, 'ok'); saveLayoutSoon(); }, function (err) { ui.toast(f.name + ': ' + ui.errorText(err), 'error'); });
                });
            }
        });

        /* ------------------------------------------------------------------------------------ keyboard */
        function neighbour(dir) {
            var cur = selected().map(function (i) { return cells[i.file]; }); if (!cur.length) return order[0];
            var from = cur[cur.length - 1], best = null, bestScore = Infinity;
            items.forEach(function (it) {
                var c = cells[it.file], dc = c.c - from.c, dr = c.r - from.r;
                if ((dir === 'ArrowLeft' && dc >= 0) || (dir === 'ArrowRight' && dc <= 0) || (dir === 'ArrowUp' && dr >= 0) || (dir === 'ArrowDown' && dr <= 0)) return;
                var score = dir === 'ArrowLeft' || dir === 'ArrowRight' ? Math.abs(dc) * 10 + Math.abs(dr) : Math.abs(dr) * 10 + Math.abs(dc);
                if (score < bestScore) { best = it.path; bestScore = score; }
            });
            return best;
        }
        surface.addEventListener('keydown', function (e) {
            if (renaming) return;
            var sel = selected();
            if (e.key === 'Enter' && sel.length) { e.preventDefault(); sel.forEach(openItem); }
            else if (e.key === 'Delete' && sel.length) { e.preventDefault(); remove(sel); }
            else if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); rename(sel[0]); }
            else if (e.key === 'F5') { e.preventDefault(); refresh(); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(order, true); }
            else if (e.key === 'Escape') setSelection([]);
            else if (e.key.indexOf('Arrow') === 0) {
                e.preventDefault();
                var next = neighbour(e.key);
                if (next) { if (e.shiftKey) { selection.add(next); paintSelection(); } else setSelection([next]); }
            }
        });

        // follow the file system and other windows
        h.on('fs_changed', function (ev) { if (!ev.dirs || !ev.dirs.length || ev.dirs.indexOf('/desktop') >= 0) refresh(); });
        h.on('restore', refresh);
        h.on('desktop_changed', function (ev) { if (ev.kind === 'layout' && ev.origin !== tabId) refresh(); });
        var resizeTimer = 0;
        function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (!renaming) render(); }, 80); }
        window.addEventListener('resize', onResize);
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(surface);
        __theme.onChange(function () { onResize(); });    // a taskbar of another height changes the area

        return { refresh: refresh, arrange: arrange, selection: function () { return selected(); }, focus: function () { surface.focus({ preventScroll: true }); } };
    };
})();
