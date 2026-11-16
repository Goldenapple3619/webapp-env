var __ui = (() => {
    var SPRITE = '/assets/images/icons.svg';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function icon(name, cls) {
        return '<svg class="icon ' + (cls || '') + '" aria-hidden="true"><use href="' + SPRITE + '#' + name + '"/></svg>';
    }
    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html != null) n.innerHTML = html;
        return n;
    }

    var openMenus = [];
    function closeMenus() {
        openMenus.forEach(function (m) { m.remove(); });
        openMenus = [];
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', menuKey, true);
        window.removeEventListener('blur', closeMenus);
    }
    function outside(e) { if (!openMenus.some(function (m) { return m.contains(e.target); })) closeMenus(); }
    function menuKey(e) {
        var last = openMenus[openMenus.length - 1];
        if (!last) return;
        if (e.key === 'Escape') { e.preventDefault(); closeMenus(); return; }
        var items = Array.prototype.slice.call(last.querySelectorAll('.ui-menu__item:not(:disabled)'));
        var i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    }

    function buildMenu(items, depth) {
        var menu = el('div', 'ui-menu' + (depth ? ' ui-menu--sub' : ''));
        menu.setAttribute('role', 'menu');
        menu.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        items.forEach(function (it) {
            if (it.separator) { menu.appendChild(el('div', 'ui-menu__sep')); return; }
            var b = el('button', 'ui-menu__item' + (it.danger ? ' is-danger' : ''));
            b.type = 'button';
            b.setAttribute('role', 'menuitem');
            b.disabled = !!it.disabled;
            b.innerHTML = (it.icon ? icon(it.icon) : '<span class="icon"></span>') + '<span class="ellipsis">' + esc(it.label) + '</span>' +
                (it.kbd ? '<span class="kbd">' + esc(it.kbd) + '</span>' : '') +
                (it.submenu ? '<span class="ui-menu__sub">' + icon('chevron-right') + '</span>' : '');
            if (it.submenu) {
                var openSub = function () {
                    var r = b.getBoundingClientRect();
                    Promise.resolve(typeof it.submenu === 'function' ? it.submenu() : it.submenu).then(function (list) {
                        if (!b.isConnected) return;
                        while (openMenus.length > depth + 1) openMenus.pop().remove();   // close deeper menus first
                        place(buildMenu(list.filter(Boolean), depth + 1), r.right - 4, r.top - 6, r.left);
                        b.classList.add('is-open');
                    });
                };
                b.addEventListener('click', openSub);
                b.addEventListener('mouseenter', openSub);
            } else {
                b.addEventListener('mouseenter', function () { while (openMenus.length > depth + 1) openMenus.pop().remove(); });
                b.addEventListener('click', function () {
                    closeMenus();
                    if (it.action) it.action();
                });
            }
            menu.appendChild(b);
        });
        return menu;
    }

    function place(menu, x, y, altRight) {
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        openMenus.push(menu);
        var w = menu.offsetWidth, h = menu.offsetHeight;
        if (x + w > innerWidth - 6) x = altRight != null ? altRight - w + 4 : innerWidth - w - 6;
        if (y + h > innerHeight - 6) y = Math.max(6, innerHeight - h - 6);
        menu.style.left = Math.max(6, x) + 'px';
        menu.style.top = Math.max(6, y) + 'px';
        menu.style.visibility = '';
        return menu;
    }

    function menu(items, x, y) {
        closeMenus();
        var clean = items.filter(Boolean);
        if (!clean.length) return;
        var m = place(buildMenu(clean, 0), x, y);
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', menuKey, true);
        window.addEventListener('blur', closeMenus);
        var first = m.querySelector('.ui-menu__item:not(:disabled)');
        if (first) first.focus({ preventScroll: true });
    }

    function dialog(opts) {
        return new Promise(function (resolve) {
            var previous = document.activeElement;
            var overlay = el('div', 'ui-overlay');
            var box = el('div', 'ui-dialog' + (opts.wide ? ' ui-dialog--wide' : ''));
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            if (opts.title) box.appendChild(el('h3', null, esc(opts.title)));
            var body = el('div', 'ui-dialog__body');
            if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
            box.appendChild(body);
            var actions = el('div', 'ui-dialog__actions');
            (opts.actions || []).forEach(function (a) {
                var b = el('button', 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' btn--danger' : ''), esc(a.label));
                b.type = 'button';
                b.addEventListener('click', function () { done(a.value); });
                actions.appendChild(b);
            });
            if (actions.children.length) box.appendChild(actions);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            function done(v) {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                if (previous && previous.focus) previous.focus({ preventScroll: true });
                resolve(v === undefined ? null : v);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.stopPropagation(); done(null); }
            }
            document.addEventListener('keydown', onKey, true);
            overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) done(null); });
            if (opts.onOpen) opts.onOpen(box, done);
            var focusTarget = box.querySelector('[autofocus], input, select, textarea') || actions.querySelector('.btn--primary') || actions.lastChild;
            if (focusTarget) setTimeout(function () { focusTarget.focus(); if (focusTarget.select && focusTarget.dataset.select !== 'none') focusTarget.select(); }, 0);
        });
    }

    function prompt(opts) {
        var wrap = el('div', 'ui-field');
        var id = 'p' + Math.random().toString(36).slice(2, 8);
        wrap.innerHTML = (opts.label ? '<label for="' + id + '">' + esc(opts.label) + '</label>' : '') +
            '<input class="input" id="' + id + '" type="' + (opts.password ? 'password' : 'text') + '" autocomplete="off" spellcheck="false">' +
            '<div class="ui-error" role="alert"></div>';
        var input = wrap.querySelector('input');
        var err = wrap.querySelector('.ui-error');
        input.value = opts.value || '';
        return dialog({
            title: opts.title, body: wrap,
            actions: [{ label: 'Cancel', value: null }, { label: opts.confirmText || 'OK', value: '__ok__', primary: true }],
            onOpen: function (root, close) {
                var submit = function () {
                    var v = opts.trim === false ? input.value : input.value.trim();
                    var problem = opts.validate ? opts.validate(v) : (v ? '' : 'Required');
                    if (problem) { err.textContent = problem; input.focus(); return; }
                    close({ value: v });
                };
                input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } else err.textContent = ''; });
                var ok = root.querySelector('.btn--primary');
                ok.addEventListener('click', function (e) { e.stopImmediatePropagation(); submit(); }, true);
                // select the base name only ("report" of "report.txt")
                setTimeout(function () {
                    if (opts.selectBase) { var dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : input.value.length); }
                }, 5);
                input.dataset.select = opts.selectBase ? 'none' : '';
            }
        }).then(function (r) { return r && r.value !== undefined ? r.value : null; });
    }

    function confirm(opts) {
        return dialog({
            title: opts.title || 'Confirm', body: '<p>' + esc(opts.message) + '</p>',
            actions: [{ label: opts.cancelText || 'Cancel', value: false }, { label: opts.confirmText || 'OK', value: true, primary: !opts.danger, danger: !!opts.danger }]
        }).then(function (v) { return v === true; });
    }

    function alert(opts) {
        return dialog({ title: opts.title || 'Notice', body: '<p>' + esc(opts.message) + '</p>', actions: [{ label: 'OK', value: true, primary: true }] });
    }

    var toastBox = null;
    function toast(text, kind, ms) {
        if (!toastBox || !toastBox.isConnected) { toastBox = el('div', 'ui-toasts'); toastBox.setAttribute('aria-live', 'polite'); document.body.appendChild(toastBox); }
        var t = el('div', 'ui-toast' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''),
            icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info') + '<span>' + esc(text) + '</span>');
        toastBox.appendChild(t);
        setTimeout(function () { t.remove(); }, ms || (kind === 'error' ? 6000 : 3200));
        return t;
    }

    var MESSAGES = {
        exists: 'An item with that name already exists.', not_found: 'Not found (it may have been moved or deleted).',
        invalid_name: 'That name is not allowed.', forbidden: 'That item is protected.', not_dir: 'That is not a folder.',
        is_dir: 'That is a folder.', too_large: 'The file is too large.', binary: 'This looks like a binary file.',
        conflict: 'The file changed on disk.', invalid_move: 'A folder cannot be moved into itself.', not_audio: 'Only audio files can be added.',
        payload_too_large: 'The file is too big to upload.', network_error: 'Cannot reach the server.', io_error: 'The server could not do that.',
        too_many_attempts: 'Too many attempts, try again in a moment.',
        read_only: 'That location is read-only.', reserved_name: 'That name is reserved.', busy: 'The server is busy, try again in a moment.',
        invalid_xml: 'The shortcut file is not valid XML.', forbidden_markup: 'DOCTYPE / ENTITY declarations are not allowed.',
        invalid_shortcut: 'That is not a valid shortcut.', invalid_open: 'The application id is not valid.', invalid_icon: 'The icon is not valid.',
        invalid_target: 'The target must be an absolute path.', invalid_args: 'An argument is not valid.', invalid_window: 'The window size is not valid.',
        invalid_name: 'That name is not allowed.', invalid_color: 'Colours are written like #fc82b8.', invalid_number: 'A number is out of range.',
        invalid_appearance: 'Those appearance settings are not valid.', invalid_layout: 'That desktop layout is not valid.'
    };
    function errorText(err) {
        if (err && err.details && typeof err.details.detail === 'string' && err.details.detail) return err.details.detail;   // the gateway's own sentence
        var code = err && (err.code || err.message);
        return MESSAGES[code] || (code ? String(code).replace(/_/g, ' ') : 'Something went wrong.');
    }

    return ({ icon: icon, esc: esc, el: el, menu: menu, closeMenus: closeMenus, dialog: dialog, prompt: prompt, confirm: confirm, alert: alert, toast: toast, errorText: errorText });
})();
