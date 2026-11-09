/**
 * Terminal. createTerminalView() is the reusable part (the Code editor embeds it in its bottom
 * panel); setupApp.terminalEmulator wraps it into an app. The shell itself runs on the server and
 * is virtual: it can only touch the user's own files (see socket/src/common/shell.py).
 */
(function () {
    var apps = __apps.getInstance();

    function appendAnsi(parent, text) {
        var re = /\x1b\[([0-9;]*)m/g, last = 0, classes = [], m;
        var put = function (chunk) {
            if (!chunk) return;
            var s = document.createElement('span');
            s.textContent = chunk;
            if (classes.length) s.className = classes.map(function (c) { return 'a-' + c; }).join(' ');
            parent.appendChild(s);
        };
        while ((m = re.exec(text))) {
            put(text.slice(last, m.index));
            last = re.lastIndex;
            (m[1] || '0').split(';').forEach(function (code) {
                if (code === '0' || code === '') classes = [];
                else classes.push(code);
            });
        }
        put(text.slice(last));
    }

    function commonPrefix(list) {
        var p = list[0] || '';
        list.forEach(function (s) { while (s.indexOf(p) !== 0) p = p.slice(0, -1); });
        return p;
    }

    /**
     * @param container element to fill
     * @param opts      { host: {close()}, handle?: an existing 'terminalEmulator' app handle }
     */
    function createTerminalView(container, opts) {
        opts = opts || {};
        var ws = document.wsscon;
        var root = document.createElement('div');
        root.className = 'tm';
        root.innerHTML = '<div class="tm-out" role="log" aria-live="polite"></div><div class="tm-line"><span class="tm-prompt"></span><input class="tm-input" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Command"></div>';
        container.appendChild(root);
        var out = root.querySelector('.tm-out'), input = root.querySelector('.tm-input'), promptEl = root.querySelector('.tm-prompt');

        var handle = null, cwd = '/', user = 'user', history = [], hIdx = 0, draft = '', destroyed = false;
        var queue = Promise.resolve();

        function prompt() {
            promptEl.textContent = '';
            var u = document.createElement('span'); u.className = 'user'; u.textContent = user + '@webapp-env';
            var d = document.createElement('span'); d.className = 'dir'; d.textContent = ':' + cwd;
            promptEl.append(u, d, '$');
        }
        function line(text, cls) {
            var d = document.createElement('div');
            if (cls) d.className = cls;
            appendAnsi(d, text);
            out.appendChild(d);
            while (out.childElementCount > 1500) out.firstChild.remove();
            return d;
        }
        function print(text) { // split so trailing newline does not add an empty row
            text.replace(/\n$/, '').split('\n').forEach(function (l) { line(l); });
            scroll();
        }
        function scroll() { root.scrollTop = root.scrollHeight; }

        function setup(h) {
            handle = h;
            h.on('restore', function () { h.update('set_cwd', { path: cwd }).catch(function () { }); });
            return h.fetch('prompt').then(function (p) { cwd = p.cwd; user = p.user; prompt(); });
        }
        var ready = opts.handle ? setup(opts.handle) : ws.app('terminalEmulator').then(function (h) { if (destroyed) { h.close(); return; } return setup(h); });
        ready.then(function () { if (!destroyed) { line('Virtual shell. Type "help" for the list of commands.', 'a-2'); input.focus(); } }, function (e) { line('Cannot start the shell: ' + (e.code || e.message), 'a-31'); });
        prompt();

        function act(a) {
            if (a.type === 'open') {
                if (a.app === 'music') apps.open('music', { play: a.path });
                else if (a.app === 'code') apps.open('code', { path: a.path });
                else apps.openPath(a.path, a.kind === 'folder' ? 'folder' : 'file');
            } else if (a.type === 'exit' && opts.host && opts.host.close) opts.host.close();
        }

        function run(text) {
            var echo = document.createElement('div');
            echo.className = 'echo';
            var p = document.createElement('span'); p.className = 'p'; p.textContent = user + '@webapp-env:' + cwd + '$ ';
            echo.append(p, document.createTextNode(text));
            out.appendChild(echo);
            if (!text.trim()) { scroll(); return; }
            if (history[history.length - 1] !== text) history.push(text);
            hIdx = history.length; draft = '';
            queue = queue.then(function () {
                return ready.then(function () { return handle.update('exec', { line: text }); }).then(function (r) {
                    if (r.clear) out.textContent = '';
                    if (r.output) print(r.output);
                    cwd = r.cwd; prompt();
                    (r.actions || []).forEach(act);
                }, function (e) { line('error: ' + (e.code || e.message), 'a-31'); });
            }).then(function () { scroll(); });
        }

        function complete() {
            var v = input.value, before = v.slice(0, input.selectionStart);
            if (!handle) return;
            handle.fetch('complete', { line: before }).then(function (r) {
                var m = r.matches;
                if (!m.length) return;
                var word = (before.match(/(?:\\ |[^\s])*$/) || [''])[0];
                var typed = word.replace(/\\ /g, ' ');
                var fill = m.length === 1 ? m[0] : commonPrefix(m);
                if (m.length > 1) { var e = document.createElement('div'); e.className = 'a-2'; e.textContent = m.join('   '); out.appendChild(e); scroll(); }
                if (fill.length < typed.length) return;
                var esc = fill.replace(/ /g, '\\ ') + (m.length === 1 && !/\/$/.test(fill) ? ' ' : '');
                input.value = before.slice(0, before.length - word.length) + esc + v.slice(input.selectionStart);
                input.setSelectionRange(before.length - word.length + esc.length, before.length - word.length + esc.length);
            }).catch(function () { });
        }

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); var t = input.value; input.value = ''; run(t); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (hIdx === history.length) draft = input.value; if (hIdx > 0) input.value = history[--hIdx]; }
            else if (e.key === 'ArrowDown') { e.preventDefault(); if (hIdx < history.length) { hIdx++; input.value = hIdx === history.length ? draft : history[hIdx]; } }
            else if (e.key === 'Tab') { e.preventDefault(); complete(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); out.textContent = ''; }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c') { if (!window.getSelection().toString()) { e.preventDefault(); line(promptEl.textContent + ' ' + input.value + '^C', 'echo'); input.value = ''; scroll(); } }
            else if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); input.value = ''; }
        });
        root.addEventListener('pointerdown', function (e) { if (e.target !== input && !window.getSelection().toString()) setTimeout(function () { if (!window.getSelection().toString()) input.focus(); }, 0); });

        return {
            focus: function () { input.focus(); },
            run: run,
            element: root,
            getHandle: function () { return handle; },
            destroy: function () { destroyed = true; if (handle && !opts.handle) handle.close(); root.remove(); }
        };
    }
    document.createTerminalView = createTerminalView;

    document.setupApp = document.setupApp || {};
    document.setupApp.terminalEmulator = function (parent, standalone, UIs, onConnect, options) {
        options = options || {};
        var host = options.host || { setTitle: function () { }, close: function () { } };
        var holder = document.createElement('div');
        holder.className = 'tm-host';
        parent.appendChild(holder);
        var view = createTerminalView(holder, { host: host });
        host.setTitle('');
        setTimeout(function () { if (view.getHandle() && onConnect) onConnect(view.getHandle().sessionId); view.focus(); }, 300);
        return {
            handleIntent: function (args) { if (args && args.run) view.run(args.run); view.focus(); },
            nonStandaloneDestroy: function () { view.destroy(); }
        };
    };
})();
