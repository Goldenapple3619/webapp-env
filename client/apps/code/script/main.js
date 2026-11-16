/**
 * Code editor. A <textarea> (real caret, selection, IME, native undo per tab) sits on top of a
 * syntax-highlighted <pre> with identical metrics. Backend: the "codeEditor" app of the gateway
 * (read / save with conflict detection / lint / workspace state + the shared file operations).
 */
(function () {
    var apps = __apps.getInstance();
    var auth = __auth.getInstance();
    var DIR = '/apps/code/';
    var MAX_HIGHLIGHT = 200000;
    var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    var CLOSERS = { ')': 1, ']': 1, '}': 1, '"': 1, "'": 1, '`': 1 };

    var dirname = function (p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    var basename = function (p) { return p.slice(p.lastIndexOf('/') + 1); };
    var esc = function (s) { return __ui.esc(s); };

    document.setupApp = document.setupApp || {};
    document.setupApp.codeEditor = function (parent, standalone, UIs, onConnect, options) {
        options = options || {};
        var host = options.host || { setTitle: function () { }, close: function () { }, launch: function (id, a) { return apps.open(id, a); } };
        var ws = document.wsscon;
        var ui = __ui;

        var rootEl = document.app.build(DIR + 'UI/main.html', parent);
        var $ = function (s) { return rootEl.querySelector(s); };
        var codewrap = $('#ce-codewrap'), hl = $('#ce-hl'), gutterInner = $('#ce-gutter-inner');
        var editorEl = $('#ce-editor'), welcome = $('#ce-welcome'), tabsEl = $('#ce-tabs');

        var files = null, destroyed = false;
        var docs = [], active = null, untitled = 0, nextId = 1;
        var rootPath = '/';
        var treeRoot = null, nodes = {};
        var panelTab = 'problems', termView = null;
        var fontSize = parseInt(localStorage.getItem('ce.font') || '0', 10) || 0;   // 0 = not zoomed by the user: the theme decides
        var findCase = false;
        var stateTimer = null, renderQueued = false, lastLines = -1;

        function fail(e) { ui.toast(ui.errorText(e), 'error'); }
        // The size comes from the theme (--ce-font-size, Appearance > Code) until the user zooms with Ctrl +/-; the line height
        // is always font + 7px (an INTEGER, so the line numbers, the textarea and goto-line maths can never drift apart).
        function curFont() { return fontSize || parseInt(getComputedStyle(rootEl).getPropertyValue('--ce-font-size'), 10) || 13; }
        function applyFont() {
            if (fontSize) rootEl.style.setProperty('--ce-font-size', fontSize + 'px');
            if (active) queueRender();
        }
        function lineHeight() { return curFont() + 7; }
        applyFont();

        ws.app('codeEditor').then(function (h) {
            if (destroyed) return h.close();
            files = h;
            if (onConnect) onConnect(h.sessionId);
            h.on('restore', function () { if (onConnect) onConnect(h.sessionId); refreshAllDirs(); });
            h.on('fs_changed', onFsChanged);
            return h.fetch('state').then(function (r) { return r.state || {}; }, function () { return {}; });
        }).then(function (state) {
            if (!files) return;
            rootPath = state.root || '/';
            if (state.sidebar === false) toggleSidebar(false);
            if (state.panel) togglePanel(true);
            initTree();
            var a = options.args || {};
            var tabs = (state.tabs || []).filter(function (p) { return p !== a.path; });
            var chain = Promise.resolve();
            tabs.forEach(function (p) { chain = chain.then(function () { return openFile(p, { quiet: true, background: true }); }); });
            chain.then(function () {
                if (state.active) { var d = docs.filter(function (x) { return x.path === state.active; })[0]; if (d) activate(d); }
                if (a.path) return openFile(a.path, { line: a.line });
            });
        }, fail);

        function mkNode(entry) { return { path: entry.path, name: entry.name, type: entry.type, expanded: false, children: null }; }
        function initTree() {
            treeRoot = { path: rootPath, name: rootPath === '/' ? 'Home' : basename(rootPath), type: 'folder', expanded: true, children: null };
            nodes = {}; nodes[rootPath] = treeRoot;
            $('#ce-root-label').textContent = rootPath === '/' ? 'Home' : rootPath;
            loadDir(treeRoot);
        }
        function loadDir(node) {
            if (!files) return Promise.resolve();
            return files.fetch('listdir', { path: node.path }).then(function (r) {
                var old = {};
                (node.children || []).forEach(function (c) { old[c.path] = c; });
                node.children = r.content.map(function (e) { var c = old[e.path] || mkNode(e); c.type = e.type; nodes[e.path] = c; return c; });
                renderTree();
            }, function (err) { if (node !== treeRoot) { node.children = []; renderTree(); } else fail(err); });
        }
        function refreshAllDirs() { Object.keys(nodes).forEach(function (p) { var n = nodes[p]; if (n.type === 'folder' && n.expanded && n.children) loadDir(n); }); }

        function renderTree() {
            var body = $('#ce-tree-body');
            var top = body.scrollTop;
            body.textContent = '';
            var frag = document.createDocumentFragment();
            (function walk(node, depth) {
                (node.children || []).forEach(function (c) {
                    var b = document.createElement('button');
                    b.type = 'button'; b.className = 'ce-node' + (c.expanded ? ' is-open' : '') + (active && active.path === c.path ? ' is-active' : '');
                    b.dataset.path = c.path; b.style.paddingLeft = (8 + depth * 14) + 'px'; b.title = c.path;
                    b.setAttribute('role', 'treeitem');
                    b.innerHTML = (c.type === 'folder' ? ui.icon('chevron-right', 'chev') + ui.icon('folder', 'kind-folder') : '<span class="icon"></span>' + ui.icon('file')) + '<span class="label"></span>';
                    b.lastChild.textContent = c.name;
                    frag.appendChild(b);
                    if (c.type === 'folder' && c.expanded && c.children) walk(c, depth + 1);
                });
            })(treeRoot, 0);
            body.appendChild(frag);
            body.scrollTop = top;
        }

        $('#ce-tree-body').addEventListener('click', function (e) {
            var b = e.target.closest('.ce-node');
            if (!b) return;
            var n = nodes[b.dataset.path];
            if (n.type === 'folder') { n.expanded = !n.expanded; if (n.expanded && !n.children) loadDir(n); else renderTree(); }
            else openFile(n.path);
        });
        $('#ce-tree-body').addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var b = e.target.closest('.ce-node');
            var n = b ? nodes[b.dataset.path] : treeRoot;
            var dir = n.type === 'folder' ? n : nodes[dirname(n.path)] || treeRoot;
            ui.menu([
                n.type === 'file' ? { label: 'Open', icon: 'arrow-right', action: function () { openFile(n.path); } } : null,
                { label: 'New file…', icon: 'file-plus', action: function () { newInTree('mkfile', dir); } },
                { label: 'New folder…', icon: 'folder-plus', action: function () { newInTree('mkdir', dir); } },
                n !== treeRoot ? { separator: true } : null,
                n !== treeRoot ? { label: 'Rename…', icon: 'pencil', action: function () { renameNode(n); } } : null,
                n !== treeRoot ? { label: 'Delete', icon: 'trash', danger: true, action: function () { deleteNode(n); } } : null,
                { separator: true },
                { label: 'Copy path', icon: 'copy', action: function () { if (navigator.clipboard) navigator.clipboard.writeText(n.path); } },
                { label: 'Show in Explorer', icon: 'folder', action: function () { host.launch('explorer', { path: n.path }); } },
                { label: 'Use as workspace root', icon: 'home', disabled: n.type !== 'folder', action: function () { setRoot(n.path); } },
                { label: 'Refresh', icon: 'refresh', action: function () { loadDir(dir); } }
            ], e.clientX, e.clientY);
        });
        $('.ce-tree-head').addEventListener('click', function (e) {
            var b = e.target.closest('[data-tree]');
            if (!b) { if (e.target.id === 'ce-root-label') changeRoot(); return; }
            var sel = active && active.path ? nodes[dirname(active.path)] : null;
            if (b.dataset.tree === 'refresh') refreshAllDirs();
            else newInTree(b.dataset.tree === 'file' ? 'mkfile' : 'mkdir', sel || treeRoot);
        });

        function newInTree(kind, dir) {
            ui.prompt({ title: kind === 'mkfile' ? 'New file' : 'New folder', label: 'Name (inside ' + dir.path + ')', value: kind === 'mkfile' ? 'untitled.txt' : 'new-folder', selectBase: kind === 'mkfile',
                validate: function (v) { return !v ? 'Required' : /[\/\\]/.test(v) ? 'A name cannot contain / or \\' : ''; } }).then(function (name) {
                if (!name) return;
                files.update(kind, { path: dir.path, name: name }).then(function (r) {
                    dir.expanded = true;
                    loadDir(dir).then(function () { if (kind === 'mkfile') openFile(r.path); });
                }, fail);
            });
        }
        function renameNode(n) {
            ui.prompt({ title: 'Rename', label: 'New name', value: n.name, selectBase: n.type === 'file' }).then(function (name) {
                if (!name || name === n.name) return;
                files.update('rename', { path: n.path, name: name }).then(function (r) {
                    docs.forEach(function (d) {
                        if (d.path === n.path) { d.path = r.path; d.name = basename(r.path); d.language = document.__language(r.path); }
                        else if (d.path && d.path.indexOf(n.path + '/') === 0) { d.path = r.path + d.path.slice(n.path.length); d.name = basename(d.path); }
                    });
                    delete nodes[n.path];
                    loadDir(nodes[dirname(n.path)] || treeRoot); paintTabs(); updateChrome();
                }, fail);
            });
        }
        function deleteNode(n) {
            ui.confirm({ title: 'Delete', message: 'Delete "' + n.name + '"? This cannot be undone.', confirmText: 'Delete', danger: true }).then(function (ok) {
                if (!ok) return;
                files.update('delete', { paths: [n.path] }).then(function () {
                    docs.forEach(function (d) { if (d.path === n.path || (d.path && d.path.indexOf(n.path + '/') === 0)) d.deleted = true; });
                    loadDir(nodes[dirname(n.path)] || treeRoot); paintTabs();
                }, fail);
            });
        }
        function changeRoot() {
            ui.prompt({ title: 'Workspace folder', label: 'Folder path', value: rootPath }).then(function (p) { if (p) setRoot(p); });
        }
        function setRoot(p) {
            files.fetch('stat', { path: p }).then(function (r) {
                if (r.stat.type !== 'folder') return ui.toast('That is not a folder.', 'error');
                rootPath = r.stat.path; initTree(); saveStateSoon();
            }, fail);
        }

        function makeDoc(o) {
            var ta = document.createElement('textarea');
            ta.className = 'ce-input';
            ta.spellcheck = false; ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('wrap', 'off');
            ta.setAttribute('aria-label', o.name || 'Editor');
            ta.value = o.content;
            ta.hidden = true;
            var doc = Object.assign({ id: nextId++, ta: ta, saved: o.content, problems: [], conflict: false, deleted: false, isNew: false, lintTimer: null, lintSeq: 0 }, o);
            ta.addEventListener('input', function () { onInput(doc); });
            ta.addEventListener('scroll', function () { if (doc === active) syncScroll(ta); });
            ta.addEventListener('keydown', function (e) { onKeyDown(e, doc); });
            ta.addEventListener('keyup', updateStatus);
            ta.addEventListener('click', updateStatus);
            codewrap.appendChild(ta);
            docs.push(doc);
            return doc;
        }
        var isDirty = function (d) { return d.ta.value !== d.saved; };

        function openFile(path, opts) {
            var existing = docs.filter(function (d) { return d.path === path; })[0];
            opts = opts || {};

            if (existing) {
                if (!opts.background) {
                    activate(existing);

                    if (opts.line)
                        gotoLine(existing, opts.line, opts.col);
                }
                return Promise.resolve(existing);
            }

            if (!files)
                return Promise.resolve(null);

            return (files.fetch('stat', { path: path }).then(function (r) {
                if (r.stat.type === 'folder') {
                    setRoot(path);

                    return Promise.resolve(path);
                }

                return files.fetch('read', { path: path }).then(function (r) {
                    var doc = makeDoc({ path: r.path, name: basename(r.path), content: r.content, mtime: r.mtime, eol: r.eol, encoding: r.encoding, language: document.__language(r.path) });
                    paintTabs();
                    if (!opts.background) {
                        activate(doc);
                        if (opts.line)
                            gotoLine(doc, opts.line, opts.col);
                    }
                    lint(doc, true);
                    saveStateSoon();
                    return doc;
                }, function (err) {
                    if (opts.quiet) return null;
                    if (err.code === 'binary' || err.code === 'too_large') {
                        ui.confirm({ title: 'Cannot open file', message: (err.code === 'binary' ? 'This looks like a binary file.' : 'This file is larger than 2 MB.') + ' Download it instead?', confirmText: 'Download' }).then(function (ok) {
                            if (ok) { var a = document.createElement('a'); a.href = auth.fileUrl(path, { download: true }); a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
                        });
                    } else fail(err);
                    return null;
                });
            }, fail));
        }

        function newFile() {
            var doc = makeDoc({ path: null, name: 'Untitled-' + (++untitled), content: '', mtime: null, eol: 'lf', encoding: 'utf-8', language: 'text', isNew: true });
            paintTabs(); activate(doc);
        }

        function activate(doc) {
            if (active === doc) { doc.ta.focus(); return; }
            if (active) { active.ta.hidden = true; }
            active = doc;
            docs.forEach(function (d) { d.ta.hidden = d !== doc; });
            editorEl.hidden = false; welcome.hidden = true;
            lastLines = -1;
            renderNow();
            paintTabs(); updateChrome(); paintProblems();
            $('#ce-banner').hidden = !doc.conflict;
            if (!findBar.hidden) updateFindCount();
            renderTree();
            doc.ta.focus();
            syncScroll(doc.ta);
            saveStateSoon();
        }

        function paintTabs() {
            tabsEl.textContent = '';
            docs.forEach(function (d) {
                var t = document.createElement('div');
                t.className = 'ce-tab' + (d === active ? ' is-active' : '') + (d.problems.some(function (p) { return p.severity === 'error'; }) ? ' has-error' : '');
                t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(d === active)); t.tabIndex = 0;
                t.title = d.path || d.name;
                t.innerHTML = '<span class="name"></span>' + (isDirty(d) ? '<span class="dot" title="Unsaved changes"></span>' : '') + '<span class="x" title="Close" role="button" aria-label="Close tab">' + ui.icon('x') + '</span>';
                var name = t.querySelector('.name'); name.textContent = d.name; if (d.deleted) name.style.textDecoration = 'line-through';
                t.addEventListener('click', function (e) { if (e.target.closest('.x')) closeDoc(d); else activate(d); });
                t.addEventListener('auxclick', function (e) { if (e.button === 1) closeDoc(d); });
                t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(d); } });
                tabsEl.appendChild(t);
            });
            var current = tabsEl.querySelector('.is-active');
            if (current) {   // scroll the strip itself; scrollIntoView() would also move every scrollable ancestor
                var tb = tabsEl.getBoundingClientRect(), cb = current.getBoundingClientRect();
                if (cb.left < tb.left) tabsEl.scrollLeft -= tb.left - cb.left + 8; else if (cb.right > tb.right) tabsEl.scrollLeft += cb.right - tb.right + 8;
            }
        }

        function updateChrome() {
            var d = active;
            $('#ce-title').textContent = d ? (d.path || d.name) + (isDirty(d) ? ' •' : '') : '';
            host.setTitle(d ? (isDirty(d) ? '● ' : '') + d.name : '');
            $('#ce-st-lang').textContent = d ? document.__languageLabel(d.language) : '';
            $('#ce-st-eol').textContent = d ? d.eol.toUpperCase() : '';
            $('#ce-st-enc').textContent = d ? d.encoding.toUpperCase() : '';
            updateStatus();
        }

        function closeDoc(doc) {
            var go = function () {
                var i = docs.indexOf(doc);
                docs.splice(i, 1); doc.ta.remove(); clearTimeout(doc.lintTimer);
                if (active === doc) {
                    active = null;
                    var next = docs[Math.min(i, docs.length - 1)];
                    if (next) activate(next);
                    else { editorEl.hidden = true; welcome.hidden = false; hl.textContent = ''; gutterInner.textContent = ''; paintTabs(); updateChrome(); paintProblems(); $('#ce-banner').hidden = true; renderTree(); }
                } else paintTabs();
                saveStateSoon();
                return true;
            };
            if (!isDirty(doc)) return Promise.resolve(go());
            return ui.dialog({ title: 'Unsaved changes', body: '<p>Save changes to "' + esc(doc.name) + '" before closing?</p>',
                actions: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }] }).then(function (v) {
                if (v === 'save') return save(doc).then(function (ok) { return ok ? go() : false; });
                if (v === 'discard') return go();
                return false;
            });
        }

        function queueRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(function () { renderQueued = false; renderNow(); }); }
        function renderNow() {
            if (!active) return;
            var code = active.ta.value;
            hl.innerHTML = (code.length <= MAX_HIGHLIGHT ? document.__highlight(code, active.language) : esc(code)) + '\n';
            var lines = code.split('\n').length;
            if (lines !== lastLines) {
                lastLines = lines;
                var out = new Array(lines);
                for (var i = 0; i < lines; i++) out[i] = i + 1;
                gutterInner.textContent = out.join('\n') + '\n';
                $('#ce-gutter').style.minWidth = (String(lines).length * (curFont() * 0.62) + 26) + 'px';
            }
            syncScroll(active.ta);
        }
        function syncScroll(ta) {
            hl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
            gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
        }

        function onInput(doc) {
            if (doc !== active) return;
            queueRender();
            paintTabsDirty(doc);
            updateChrome();
            scheduleLint(doc);
            if (!findBar.hidden) updateFindCount();
            saveStateSoon();
        }
        var lastDirty = null;
        function paintTabsDirty(doc) { var d = isDirty(doc); if (lastDirty !== d + ':' + doc.id) { lastDirty = d + ':' + doc.id; paintTabs(); } }

        function updateStatus() {
            var d = active;
            if (!d) { $('#ce-st-pos').textContent = ''; $('#ce-st-sel').textContent = ''; return; }
            var ta = d.ta, v = ta.value, p = ta.selectionStart;
            var before = v.slice(0, p), line = before.split('\n').length, col = p - before.lastIndexOf('\n');
            $('#ce-st-pos').textContent = 'Ln ' + line + ', Col ' + col;
            var n = ta.selectionEnd - ta.selectionStart;
            $('#ce-st-sel').textContent = n ? n + ' selected' : '';
        }
        function onSelectionChange() { if (active && document.activeElement === active.ta) updateStatus(); }
        document.addEventListener('selectionchange', onSelectionChange);   // removed in nonStandaloneDestroy: it used to outlive the window

        function insert(ta, text) {
            ta.focus();
            if (!document.execCommand('insertText', false, text)) {
                ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        function replaceRange(ta, start, end, text, selA, selB) {
            ta.setSelectionRange(start, end);
            insert(ta, text);
            if (selA != null) ta.setSelectionRange(selA, selB);
        }
        /** whole lines touched by the selection: [start, end) offsets */
        function lineBlock(ta) {
            var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
            var start = v.lastIndexOf('\n', s - 1) + 1;
            if (e > s && v[e - 1] === '\n') e--;
            var end = v.indexOf('\n', e); if (end < 0) end = v.length;
            return [start, end];
        }
        function indentSel(ta, out) {
            var b = lineBlock(ta), text = ta.value.slice(b[0], b[1]), s = ta.selectionStart, e = ta.selectionEnd;
            var lines = text.split('\n'), delta0 = 0, total = 0;
            var res = lines.map(function (l, i) {
                if (!out) { total += 4; if (i === 0) delta0 = 4; return '    ' + l; }
                var m = /^( {1,4}|\t)/.exec(l);
                if (!m) return l;
                total -= m[0].length; if (i === 0) delta0 = -m[0].length; return l.slice(m[0].length);
            });
            replaceRange(ta, b[0], b[1], res.join('\n'), Math.max(b[0], s + delta0), e + total);
        }
        function toggleComment(ta, lang) {
            var prefix = document.__commentPrefix(lang);
            if (!prefix) return;
            var b = lineBlock(ta), lines = ta.value.slice(b[0], b[1]).split('\n');
            var allOn = lines.every(function (l) { return !l.trim() || l.trim().indexOf(prefix) === 0; });
            var res = lines.map(function (l) {
                if (!l.trim()) return l;
                if (allOn) return l.replace(prefix + ' ', '').replace(prefix, '');
                return l.replace(/^(\s*)/, '$1' + prefix + ' ');
            }).join('\n');
            replaceRange(ta, b[0], b[1], res, b[0], b[0] + res.length);
        }

        function onKeyDown(e, doc) {
            var ta = doc.ta, mod = e.ctrlKey || e.metaKey, k = e.key;
            var v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;

            if (k === 'Tab' && !mod && !e.altKey) {
                e.preventDefault();
                var multi = v.slice(s, en).indexOf('\n') >= 0;
                if (e.shiftKey || multi) indentSel(ta, e.shiftKey); else insert(ta, '    ');
                return;
            }
            if (k === 'Enter' && !mod && !e.shiftKey) {
                e.preventDefault();
                var ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s), indent = /^[ \t]*/.exec(line)[0];
                var prev = v[s - 1], next = v[en];
                var opens = doc.language === 'python' ? /[:{\[(]\s*$/.test(line) : /[{\[(]\s*$/.test(line);
                if (prev && '{[('.indexOf(prev) >= 0 && next === PAIRS[prev]) {
                    insert(ta, '\n' + indent + '    \n' + indent);
                    var pos = s + 1 + indent.length + 4; ta.setSelectionRange(pos, pos);
                } else insert(ta, '\n' + indent + (opens ? '    ' : ''));
                return;
            }
            if (mod && (k === '/' || k === '?') ) { e.preventDefault(); toggleComment(ta, doc.language); return; }
            if (mod && k.toLowerCase() === 'd' && e.shiftKey) { // duplicate line(s)
                e.preventDefault(); var b = lineBlock(ta); var t = v.slice(b[0], b[1]); replaceRange(ta, b[1], b[1], '\n' + t); return;
            }
            if (k === 'Backspace' && s === en && s > 0 && PAIRS[v[s - 1]] && PAIRS[v[s - 1]] === v[s]) {
                e.preventDefault(); replaceRange(ta, s - 1, s + 1, ''); return;
            }
            if (!mod && !e.altKey && k.length === 1) {
                if (CLOSERS[k] && s === en && v[s] === k) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return; }   // step over an auto-inserted closer
                if (PAIRS[k]) {
                    var quote = /["'`]/.test(k), before = v[s - 1] || '', after = v[en] || '';
                    if (s !== en) { e.preventDefault(); replaceRange(ta, s, en, k + v.slice(s, en) + PAIRS[k], s + 1, en + 1); return; }  // wrap selection
                    if (quote && /\w/.test(before)) return;                                   // apostrophe inside a word
                    if (after === '' || /[\s)\]};,.:]/.test(after)) { e.preventDefault(); insert(ta, k + PAIRS[k]); ta.setSelectionRange(s + 1, s + 1); }
                }
            }
        }

        function gotoLine(doc, line, col) {
            var v = doc.ta.value, idx = 0;
            for (var i = 1; i < line && idx >= 0; i++) { idx = v.indexOf('\n', idx); if (idx >= 0) idx++; }
            if (idx < 0) idx = v.length;
            var pos = Math.min(v.length, idx + Math.max(0, (col || 1) - 1));
            doc.ta.focus();
            doc.ta.setSelectionRange(pos, pos);
            doc.ta.scrollTop = Math.max(0, (line - 1) * lineHeight() - doc.ta.clientHeight / 3);
            syncScroll(doc.ta); updateStatus();
        }
        function promptGoto() {
            if (!active) return;
            ui.prompt({ title: 'Go to line', label: 'Line number', value: '', validate: function (v) { return /^\d+$/.test(v) ? '' : 'Enter a number'; } }).then(function (n) { if (n) gotoLine(active, parseInt(n, 10)); });
        }

        var findBar = $('#ce-find'), findQ = $('#ce-find-q'), findR = $('#ce-find-r'), findN = $('#ce-find-n');
        function matches() {
            if (!active || !findQ.value) return [];
            var hay = findCase ? active.ta.value : active.ta.value.toLowerCase(), needle = findCase ? findQ.value : findQ.value.toLowerCase();
            var out = [], i = 0;
            while ((i = hay.indexOf(needle, i)) >= 0 && out.length < 10000) { out.push(i); i += Math.max(1, needle.length); }
            return out;
        }
        function updateFindCount() {
            var m = matches(), p = active ? active.ta.selectionStart : 0;
            var idx = m.findIndex(function (x) { return x >= p; });
            findN.textContent = findQ.value ? (m.length ? (idx < 0 ? 1 : idx + 1) + ' of ' + m.length : 'No results') : '';
        }
        function find(dir) {
            var m = matches();
            if (!m.length) { updateFindCount(); return; }
            var ta = active.ta, len = findQ.value.length, pos = dir > 0 ? ta.selectionEnd : ta.selectionStart - 1;
            var hit = dir > 0 ? m.find(function (x) { return x >= pos; }) : m.slice().reverse().find(function (x) { return x <= pos - len + 1 && x < ta.selectionStart; });
            if (hit === undefined) hit = dir > 0 ? m[0] : m[m.length - 1];
            ta.setSelectionRange(hit, hit + len);
            var line = ta.value.slice(0, hit).split('\n').length;
            var y = (line - 1) * lineHeight();
            if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 40) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
            syncScroll(ta); updateStatus();
            var i = m.indexOf(hit); findN.textContent = (i + 1) + ' of ' + m.length;
        }
        function replaceOne() {
            if (!active || !findQ.value) return;
            var ta = active.ta, sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
            if ((findCase ? sel : sel.toLowerCase()) === (findCase ? findQ.value : findQ.value.toLowerCase())) insert(ta, findR.value);
            find(1);
        }
        function replaceAll() {
            var m = matches();
            if (!m.length) return;
            var ta = active.ta, len = findQ.value.length, out = '', last = 0, v = ta.value;
            m.forEach(function (i) { out += v.slice(last, i) + findR.value; last = i + len; });
            out += v.slice(last);
            replaceRange(ta, 0, v.length, out, 0, 0);
            ui.toast('Replaced ' + m.length + (m.length === 1 ? ' occurrence' : ' occurrences'), 'ok');
        }
        function openFind(replace) {
            if (!active) return;
            findBar.hidden = false; findR.hidden = !replace;
            var sel = active.ta.value.slice(active.ta.selectionStart, active.ta.selectionEnd);
            if (sel && sel.indexOf('\n') < 0) findQ.value = sel;
            (replace && findQ.value ? findR : findQ).focus(); findQ.select(); updateFindCount();
        }
        function closeFind() { findBar.hidden = true; if (active) active.ta.focus(); }
        findQ.addEventListener('input', function () { updateFindCount(); });
        findBar.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); closeFind(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.target === findR ? replaceOne() : find(e.shiftKey ? -1 : 1); }
        });
        findBar.addEventListener('click', function (e) {
            var b = e.target.closest('[data-find]');
            if (!b) return;
            ({ next: function () { find(1); }, prev: function () { find(-1); }, replace: replaceOne, all: replaceAll, close: closeFind,
                'case': function () { findCase = !findCase; b.setAttribute('aria-pressed', String(findCase)); updateFindCount(); } })[b.dataset.find]();
        });

        function save(doc, force) {
            doc = doc || active;
            if (!doc) return Promise.resolve(false);
            var pathStep = doc.path ? Promise.resolve(doc.path) : ui.prompt({ title: 'Save as', label: 'File path', value: '/documents/' + doc.name + '.txt',
                validate: function (v) { return /^\/.*[^\/]$/.test(v) ? '' : 'Enter an absolute file path, e.g. /documents/a.txt'; } });
            return pathStep.then(function (path) {
                if (!path) return false;
                var check = doc.isNew ? files.fetch('stat', { path: path }).then(function () {
                    return ui.confirm({ title: 'Overwrite?', message: path + ' already exists. Replace it?', confirmText: 'Replace', danger: true });
                }, function () { return true; }) : Promise.resolve(true);
                return check.then(function (ok) {
                    if (!ok) return false;
                    var content = doc.ta.value;
                    return files.update('save', { path: path, content: content, base_mtime: doc.isNew || doc.deleted ? undefined : doc.mtime, force: !!force || doc.isNew, eol: doc.eol, create: doc.isNew || doc.deleted }).then(function (r) {
                        doc.path = r.path; doc.name = basename(r.path); doc.language = document.__language(r.path);
                        doc.saved = content; doc.mtime = r.mtime; doc.isNew = false; doc.deleted = false; doc.conflict = false;
                        doc.ta.setAttribute('aria-label', doc.name);
                        if (doc === active) { $('#ce-banner').hidden = true; renderNow(); }
                        paintTabs(); updateChrome(); lastDirty = null;
                        if (r.created) { var n = nodes[dirname(r.path)]; if (n) loadDir(n); }
                        saveStateSoon(); lint(doc, true);
                        return true;
                    }, function (err) {
                        if (err.code === 'conflict') {
                            return ui.confirm({ title: 'File changed on disk', message: '"' + doc.name + '" was modified by someone else since you opened it. Overwrite their changes?', confirmText: 'Overwrite', danger: true })
                                .then(function (yes) { return yes ? save(doc, true) : false; });
                        }
                        fail(err); return false;
                    });
                });
            });
        }
        function saveAll() { return docs.filter(isDirty).reduce(function (p, d) { return p.then(function (ok) { return ok ? save(d) : false; }); }, Promise.resolve(true)); }

        function reloadDoc(doc, r) {
            doc.ta.value = r.content; doc.saved = r.content; doc.mtime = r.mtime; doc.eol = r.eol; doc.conflict = false;
            if (doc === active) { renderNow(); $('#ce-banner').hidden = true; }
            paintTabs(); updateChrome(); lint(doc, true);
        }
        function onFsChanged(d) {
            (d.dirs || []).forEach(function (dir) { var n = nodes[dir]; if (n && n.expanded && n.children) loadDir(n); });
            (d.files || []).forEach(function (f) {
                var doc = docs.filter(function (x) { return x.path === f && !x.isNew; })[0];
                if (!doc) return;
                files.fetch('read', { path: f }).then(function (r) {
                    if (r.mtime === doc.mtime) return;
                    if (!isDirty(doc)) { reloadDoc(doc, r); ui.toast(doc.name + ' reloaded (changed on disk)'); }
                    else { doc.conflict = true; if (doc === active) $('#ce-banner').hidden = false; }
                }, function (err) { if (err.code === 'not_found') { doc.deleted = true; paintTabs(); } });
            });
        }
        $('#ce-banner').addEventListener('click', function (e) {
            var b = e.target.closest('[data-banner]');
            if (!b || !active) return;
            var doc = active;
            files.fetch('read', { path: doc.path }).then(function (r) {
                if (b.dataset.banner === 'reload') reloadDoc(doc, r);
                else { doc.mtime = r.mtime; doc.conflict = false; $('#ce-banner').hidden = true; }   // keep mine: next save wins
            }, fail);
        });

        function scheduleLint(doc) { clearTimeout(doc.lintTimer); doc.lintTimer = setTimeout(function () { lint(doc); }, 600); }
        function lint(doc, now) {
            if (!files || (doc.language !== 'python' && doc.language !== 'json')) { doc.problems = []; if (doc === active) paintProblems(); return; }
            var seq = ++doc.lintSeq;
            files.fetch('lint', { language: doc.language, content: doc.ta.value }).then(function (r) {
                if (seq !== doc.lintSeq || !docs.includes(doc)) return;
                doc.problems = r.problems;
                paintTabs(); if (doc === active) paintProblems();
            }, function () { });
        }
        function paintProblems() {
            var list = active ? active.problems : [], box = $('#ce-problems');
            var errors = list.filter(function (p) { return p.severity === 'error'; }).length;
            $('#ce-pcount').textContent = list.length;
            $('#ce-st-problems span').textContent = errors + (errors === 1 ? ' error' : ' errors') + (list.length - errors ? ', ' + (list.length - errors) + ' warnings' : '');
            box.textContent = '';
            if (!list.length) { box.innerHTML = '<div class="ce-none">' + (active ? 'No problems detected in this file.' : 'Open a file to see its problems.') + '</div>'; return; }
            list.forEach(function (p) {
                var b = document.createElement('button');
                b.type = 'button'; b.className = 'ce-problem';
                b.innerHTML = '<span class="sev">' + ui.icon('alert') + '</span><span></span><span class="loc">Ln ' + p.line + ', Col ' + p.col + '</span>';
                b.children[1].textContent = p.message;
                b.addEventListener('click', function () { gotoLine(active, p.line, p.col); });
                box.appendChild(b);
            });
        }

        var LAYOUT_KEY = 'ce.layout';
        var layoutPrefs = {}; try { layoutPrefs = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {}; } catch (e) { layoutPrefs = {}; }
        function applyLayout() {
            var w = rootEl.clientWidth || 800, hgt = rootEl.clientHeight || 500;
            if (layoutPrefs.tree) rootEl.style.setProperty('--ce-tree-w', Math.max(140, Math.min(layoutPrefs.tree, w * 0.6)) + 'px');
            if (layoutPrefs.panel) rootEl.style.setProperty('--ce-panel-h', Math.max(80, Math.min(layoutPrefs.panel, hgt * 0.7)) + 'px');
        }
        function splitter(el, axis) {
            function setSize(px) {
                var box = rootEl.getBoundingClientRect();
                if (axis === 'x') layoutPrefs.tree = Math.round(Math.max(140, Math.min(px, box.width * 0.6)));
                else layoutPrefs.panel = Math.round(Math.max(80, Math.min(px, box.height * 0.7)));
                applyLayout(); try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutPrefs)); } catch (e) { /* private mode */ }
            }
            el.addEventListener('pointerdown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                el.setPointerCapture(e.pointerId); el.classList.add('is-active'); rootEl.classList.add('is-resizing');
                function move(ev) {
                    var box = rootEl.getBoundingClientRect();
                    // the tree sits on the right: its width is the distance from the pointer to the right edge; the panel hangs from the bottom (above the status bar)
                    if (axis === 'x') setSize(box.right - ev.clientX); else setSize(box.bottom - ev.clientY - 24);
                }
                function up() { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('is-active'); rootEl.classList.remove('is-resizing'); }
                el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
            });
            el.addEventListener('keydown', function (e) {   // keyboard: arrows resize in 16px steps
                var step = (e.shiftKey ? 48 : 16), cur = axis === 'x' ? ($('#ce-tree').offsetWidth) : ($('#ce-panel').offsetHeight);
                var grow = axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp', shrink = axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
                if (grow || shrink) { e.preventDefault(); setSize(cur + (grow ? step : -step)); }
            });
            el.addEventListener('dblclick', function () { delete layoutPrefs[axis === 'x' ? 'tree' : 'panel']; rootEl.style.removeProperty(axis === 'x' ? '--ce-tree-w' : '--ce-panel-h'); try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutPrefs)); } catch (e) { /* private mode */ } });
        }
        splitter($('#ce-split-v'), 'x'); splitter($('#ce-split-h'), 'y');
        applyLayout();
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(applyLayout).observe(rootEl);

        function toggleSidebar(force) { var t = $('#ce-tree'); var hide = force === undefined ? !t.classList.contains('is-hidden') : !force; t.classList.toggle('is-hidden', hide); $('#ce-split-v').hidden = hide; saveStateSoon(); }
        function togglePanel(force) {
            var p = $('#ce-panel'); var show = force === undefined ? p.hidden : force;
            p.hidden = !show;
            $('#ce-split-h').hidden = !show;
            if (show) showPanelTab(panelTab);
            saveStateSoon();
        }
        function showPanelTab(t) {
            panelTab = t;
            rootEl.querySelectorAll('[data-ptab]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.ptab === t); });
            $('#ce-problems').hidden = t !== 'problems'; $('#ce-term').hidden = t !== 'terminal';
            if (t === 'terminal' && !termView) {
                document.app.loadApp('/apps/terminal/index.json').then(function () {
                    termView = document.createTerminalView($('#ce-term'), { host: { close: function () { togglePanel(false); } } });
                    termView.focus();
                }, fail);
            } else if (t === 'terminal' && termView) termView.focus();
        }
        rootEl.querySelector('.ce-panel-tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-ptab]'); if (b) showPanelTab(b.dataset.ptab); });

        function fileMenu() { return [
            { label: 'New file', icon: 'file-plus', kbd: 'Ctrl+N', action: newFile },
            { label: 'Open file…', icon: 'folder', action: function () { ui.prompt({ title: 'Open file', label: 'File path', value: active && active.path ? active.path : '/documents/' }).then(function (p) { if (p) openFile(p); }); } },
            { separator: true },
            { label: 'Save', icon: 'save', kbd: 'Ctrl+S', disabled: !active, action: function () { save(); } },
            { label: 'Save all', icon: 'save', action: saveAll },
            { separator: true },
            { label: 'Close tab', icon: 'x', kbd: 'Ctrl+W', disabled: !active, action: function () { if (active) closeDoc(active); } },
            { label: 'Workspace folder…', icon: 'home', action: changeRoot },
            { label: 'Show in Explorer', icon: 'folder', disabled: !active || !active.path, action: function () { host.launch('explorer', { path: active.path }); } }
        ]; }
        function editMenu() { return [
            { label: 'Undo', kbd: 'Ctrl+Z', disabled: !active, action: function () { active.ta.focus(); document.execCommand('undo'); } },
            { label: 'Redo', kbd: 'Ctrl+Y', disabled: !active, action: function () { active.ta.focus(); document.execCommand('redo'); } },
            { separator: true },
            { label: 'Find', icon: 'search', kbd: 'Ctrl+F', disabled: !active, action: function () { openFind(false); } },
            { label: 'Replace', kbd: 'Ctrl+H', disabled: !active, action: function () { openFind(true); } },
            { label: 'Go to line…', kbd: 'Ctrl+G', disabled: !active, action: promptGoto },
            { separator: true },
            { label: 'Toggle line comment', kbd: 'Ctrl+/', disabled: !active, action: function () { toggleComment(active.ta, active.language); } },
            { label: 'Indent / outdent', kbd: 'Tab', disabled: true }
        ]; }
        function viewMenu() { return [
            { label: 'File tree', icon: 'sidebar', kbd: 'Ctrl+B', action: function () { toggleSidebar(); } },
            { label: 'Problems & terminal', icon: 'terminal', kbd: 'Ctrl+J', action: function () { togglePanel(); } },
            { separator: true },
            { label: 'Larger text', icon: 'plus', kbd: 'Ctrl+=', action: function () { setFont(curFont() + 1); } },
            { label: 'Smaller text', icon: 'minus', kbd: 'Ctrl+-', action: function () { setFont(curFont() - 1); } }
        ]; }
        function setFont(n) { fontSize = Math.max(10, Math.min(24, n)); localStorage.setItem('ce.font', String(fontSize)); applyFont(); }

        rootEl.querySelector('.ce-menubar').addEventListener('click', function (e) {
            var m = e.target.closest('[data-menu]'), t = e.target.closest('[data-act]');
            if (m) { var r = m.getBoundingClientRect(); ui.menu({ file: fileMenu, edit: editMenu, view: viewMenu }[m.dataset.menu](), r.left, r.bottom + 2); return; }
            if (t) ({ save: function () { save(); }, panel: function () { togglePanel(); }, sidebar: function () { toggleSidebar(); } })[t.dataset.act]();
        });
        $('#ce-st-problems').addEventListener('click', function () { togglePanel(true); showPanelTab('problems'); });

        rootEl.addEventListener('keydown', function (e) {
            var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
            if (!mod) return;
            var handled = true;
            if (k === 's' && !e.shiftKey) save(); else if (k === 's' && e.shiftKey) saveAll();
            else if (k === 'f') openFind(false); else if (k === 'h') openFind(true); else if (k === 'g') promptGoto();
            else if (k === 'b') toggleSidebar(); else if (k === 'j') togglePanel();
            else if (k === 'w' && active) closeDoc(active); else if (k === 'n') newFile();
            else if (e.key === '=' || e.key === '+') setFont(curFont() + 1); else if (e.key === '-') setFont(curFont() - 1);
            else handled = false;
            if (handled) e.preventDefault();
        });

        function saveStateSoon() {
            clearTimeout(stateTimer);
            stateTimer = setTimeout(function () {
                if (!files || destroyed) return;
                files.update('state', { state: { root: rootPath, tabs: docs.filter(function (d) { return d.path; }).map(function (d) { return d.path; }), active: active && active.path || null,
                    sidebar: !$('#ce-tree').classList.contains('is-hidden'), panel: !$('#ce-panel').hidden } }).catch(function () { });
            }, 1200);
        }
        function beforeUnload(e) { if (docs.some(isDirty)) { e.preventDefault(); e.returnValue = ''; } }
        if (standalone) window.addEventListener('beforeunload', beforeUnload);

        paintProblems();

        return {
            handleIntent: function (args) { if (args && args.path) openFile(args.path, { line: args.line, col: args.col }); },

            canClose: function () {
                var dirty = docs.filter(isDirty);
                if (!dirty.length) return true;
                return ui.dialog({ title: 'Unsaved changes', body: '<p>' + dirty.length + (dirty.length === 1 ? ' file has' : ' files have') + ' unsaved changes:</p><ul>' + dirty.map(function (d) { return '<li>' + esc(d.name) + '</li>'; }).join('') + '</ul>',
                    actions: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard', danger: true }, { label: 'Save all', value: 'save', primary: true }] }).then(function (v) {
                    if (v === 'discard') return true;
                    if (v === 'save') return saveAll();
                    return false;
                });
            },
            nonStandaloneDestroy: function () {
                destroyed = true;
                clearTimeout(stateTimer);
                window.removeEventListener('beforeunload', beforeUnload);
                document.removeEventListener('selectionchange', onSelectionChange);
                if (termView) termView.destroy();
                if (files) files.close();
            }
        };
    };
})();
