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
        var queue = Promise.resolve(), epoch = 0, busy = 0;
        var waiters = {}, early = {};     // running programs: job id -> resolver / result that arrived before its reply

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

        function setBusy(on) {
            busy = Math.max(0, busy + (on ? 1 : -1));
            root.classList.toggle('is-busy', busy > 0);
            var spin = promptEl.querySelector('.tm-spin');
            if (busy > 0 && !spin) { spin = document.createElement('span'); spin.className = 'tm-spin'; spin.setAttribute('role', 'status'); spin.setAttribute('aria-label', 'A program is running'); promptEl.appendChild(spin); }
            else if (busy === 0 && spin) spin.remove();
        }
        /** the result of a program that runs in the sandbox: it arrives as an event, possibly BEFORE the reply that announced it */
        function waitFor(job) {
            if (early[job]) { var r = early[job]; delete early[job]; return Promise.resolve(r); }
            setBusy(true);
            return new Promise(function (resolve) { waiters[job] = function (ev) { setBusy(false); resolve(ev); }; });
        }

        function setup(h) {
            handle = h;
            h.on('exec_done', function (ev) {
                if (waiters[ev.job]) { var w = waiters[ev.job]; delete waiters[ev.job]; w(ev); }
                else { early[ev.job] = ev; setTimeout(function () { delete early[ev.job]; }, 30000); }
            });
            h.on('restore', function () {   // the connection was lost: whatever was running there is gone
                Object.keys(waiters).forEach(function (j) { var w = waiters[j]; delete waiters[j]; w({ output: '\x1b[31mconnection lost: the program was stopped\x1b[0m\n', status: 1, cwd: cwd, actions: [] }); });
                h.update('set_cwd', { path: cwd }).catch(function () { });
            });
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
            var mine = epoch;
            queue = queue.then(function () {
                if (mine !== epoch) return;      // Ctrl+C: lines typed ahead of the interrupted program are dropped, like in a real shell
                return ready.then(function () { return handle.update('exec', { line: text }); }).then(function (r) {
                    return r.pending ? waitFor(r.pending) : r;
                }).then(function (r) {
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
            else if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection().toString() && busy > 0) {
                e.preventDefault(); epoch++; line('^C', 'echo');
                if (handle) handle.update('kill').catch(function () { });
            }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c') { if (!window.getSelection().toString()) { e.preventDefault(); line(promptEl.textContent + ' ' + input.value + '^C', 'echo'); input.value = ''; scroll(); } }
            else if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); input.value = ''; }
        });
        root.addEventListener('pointerdown', function (e) { if (e.target !== input && !window.getSelection().toString()) setTimeout(function () { if (!window.getSelection().toString()) input.focus(); }, 0); });

        return {
            focus: function () { input.focus(); },
            run: run,
            /** { cwd, run }: start in a folder, run a command (what a shortcut's <arg name="cwd"/"run"> hands over) */
            intent: function (args) {
                ready.then(function () {
                    var go = args.cwd ? handle.update('set_cwd', { path: String(args.cwd) }).then(function (r) { cwd = r.cwd; prompt(); }) : Promise.resolve();
                    return go.then(function () { if (args.run) run(String(args.run)); });
                }).catch(function () { });
            },
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
        if (options.args && (options.args.run || options.args.cwd)) view.intent(options.args);
        setTimeout(function () { if (view.getHandle() && onConnect) onConnect(view.getHandle().sessionId); view.focus(); }, 300);
        return {
            handleIntent: function (args) { view.intent(args || {}); view.focus(); },
            nonStandaloneDestroy: function () { view.destroy(); }
        };
    };
})();
