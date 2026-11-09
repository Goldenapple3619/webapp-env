/**
 * Explorer. Same code in a desktop window and in its own page; `options.host` adapts the
 * differences. Server side is the "explorer" app of the gateway (listdir, mkdir, rename, move...).
 */
(function () {
    var auth = __auth.getInstance();
    var apps = __apps.getInstance();
    var DIR = '/apps/explorer/';

    var AUDIO = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'aac', 'opus'];
    var IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
    var THUMB_MAX = 8 * 1024 * 1024;

    var fmtSize = function (n) {
        if (n < 1024) return n + ' B';
        var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
        return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
    };
    var fmtDate = function (s) { return new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
    var dirname = function (p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
    var basename = function (p) { return p.slice(p.lastIndexOf('/') + 1); };
    var joinPath = function (a, b) { return (a === '/' ? '' : a) + '/' + b; };
    var isAudio = function (it) { return it.type === 'file' && AUDIO.indexOf(it.ext) >= 0; };

    document.setupApp = document.setupApp || {};
    document.setupApp.explorer = function (parent, standalone, UIs, onConnect, options) {
        options = options || {};
        var host = options.host || { setTitle: function () { }, close: function () { }, launch: function (id, a) { return apps.open(id, a); } };
        var ws = document.wsscon;
        var ui = __ui;

        var rootEl = document.app.build(DIR + 'UI/main.html', parent);
        var $ = function (sel) { return rootEl.querySelector(sel); };
        var itemsEl = $('#xp-items'), pathEl = $('#xp-path'), mainEl = $('#xp-main'), emptyEl = $('#xp-empty');
        var searchEl = $('#xp-search'), sortEl = $('#xp-sort'), countEl = $('#xp-count'), uploadEl = $('#xp-upload');

        // ------------------------------------------------------------------------------- state
        var path = '/', items = [], selected = new Set(), anchor = null;
        var back = [], forward = [];
        var clip = null;                                    // { mode: 'copy' | 'cut', paths: [] }
        var view = localStorage.getItem('xp.view') || 'grid';
        var sort = { key: localStorage.getItem('xp.sort') || 'name', dir: 1 };
        var showHidden = localStorage.getItem('xp.hidden') === '1';
        var query = '', searching = false, searchSeq = 0;
        var files = null, music = null, playlists = [];
        var destroyed = false, reloadTimer = null, loadSeq = 0;

        function toast(msg, kind) { ui.toast(msg, kind); }
        function fail(err) { toast(ui.errorText(err), 'error'); }

        // ------------------------------------------------------------------------- gateway session
        ws.app('explorer').then(function (h) {
            if (destroyed) return h.close();
            files = h;
            if (onConnect) onConnect(h.sessionId);
            h.on('restore', function () { if (onConnect) onConnect(h.sessionId); reload(); loadPlaces(); });
            h.on('fs_changed', function (d) {
                var hit = !searching && (d.dirs.indexOf(path) >= 0 || d.files.some(function (f) { return dirname(f) === path || f === path; }));
                if (hit) { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 150); }
            });
            loadPlaces();
            start();
        }, function (e) { fail(e); });

        function ensureMusic() {
            if (music) return Promise.resolve(music);
            return ws.app('music').then(function (h) {
                music = h;
                var refresh = function () { return h.fetch('playlists').then(function (r) { playlists = r.content; }, function () { }); };
                h.on('playlists_changed', refresh); h.on('restore', refresh);
                return refresh().then(function () { return h; });
            });
        }

        // ------------------------------------------------------------------------------ navigation
        function start() {
            var a = options.args || {};
            var initial = a.path || (standalone && location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '/');
            go(initial, { push: false, reveal: !!a.path });
        }

        function go(target, opts) {
            opts = opts || {};
            target = normalize(target);
            return files.fetch('listdir', { path: target }).then(function (r) {
                if (destroyed) return;
                if (opts.push !== false && r.fetched !== path) { back.push(path); forward = []; }
                path = r.fetched;
                setItems(r.content);
                selected.clear(); anchor = null;
                if (opts.select) opts.select.forEach(function (p) { selected.add(p); });
                searchEl.value = ''; query = ''; searching = false;
                render(true);
                updateNav();
                if (standalone && ('#' + path) !== decodeURIComponent(location.hash)) history.replaceState(null, '', '#' + encodeURI(path));
                host.setTitle(path === '/' ? 'Home' : basename(path));
            }, function (err) {
                // a path to a file: open its folder and select it
                if (err.code === 'not_dir') return go(dirname(target), { select: [target], push: opts.push });
                fail(err);
            });
        }

        function normalize(p) {
            var out = [];
            String(p || '/').replace(/\\/g, '/').split('/').forEach(function (s) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
            return '/' + out.join('/');
        }

        function reload() {
            if (!files || destroyed) return;
            var seq = ++loadSeq;
            files.fetch('listdir', { path: path }).then(function (r) {
                if (seq !== loadSeq || destroyed) return;
                setItems(r.content);
                var alive = new Set(items.map(function (i) { return i.path; }));
                selected.forEach(function (p) { if (!alive.has(p)) selected.delete(p); });
                render(false);
            }, function (err) { if (err.code === 'not_found' && path !== '/') go(dirname(path), { push: false }); });
        }

        function setItems(list) { items = list; }

        function updateNav() {
            rootEl.querySelector('[data-act=back]').disabled = !back.length;
            rootEl.querySelector('[data-act=forward]').disabled = !forward.length;
            rootEl.querySelector('[data-act=up]').disabled = path === '/';
            renderPath();
            highlightPlaces();
        }

        // -------------------------------------------------------------------------------- path bar
        function renderPath() {
            pathEl.classList.remove('is-editing');
            pathEl.textContent = '';
            var parts = path.split('/').filter(Boolean), acc = '';
            var crumb = function (label, to, iconHtml) {
                var b = document.createElement('button');
                b.type = 'button'; b.className = 'crumb'; b.dataset.path = to;
                if (iconHtml) b.innerHTML = iconHtml; else b.textContent = label;
                b.title = to;
                b.addEventListener('click', function (e) { e.stopPropagation(); go(to); });
                pathEl.appendChild(b);
            };
            crumb('', '/', ui.icon('home'));
            parts.forEach(function (p) {
                acc += '/' + p;
                var s = document.createElement('span'); s.className = 'crumb-sep'; s.innerHTML = ui.icon('chevron-right');
                pathEl.appendChild(s);
                crumb(p, acc);
            });
        }

        function editPath() {
            pathEl.classList.add('is-editing');
            pathEl.textContent = '';
            var input = document.createElement('input');
            input.value = path; input.setAttribute('aria-label', 'Path'); input.spellcheck = false;
            pathEl.appendChild(input);
            input.focus(); input.select();
            var done = function (apply) {
                if (!pathEl.contains(input)) return;
                var v = input.value.trim();
                renderPath();
                if (apply && v && normalize(v) !== path) go(v);
            };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); done(true); }
                if (e.key === 'Escape') { e.stopPropagation(); done(false); }
            });
            input.addEventListener('blur', function () { done(false); });
        }
        pathEl.addEventListener('click', function (e) { if (e.target === pathEl) editPath(); });

        // ----------------------------------------------------------------------------------- places
        function loadPlaces() {
            if (!files) return;
            files.fetch('places').then(function (r) {
                var el = $('#xp-places');
                el.textContent = '';
                [{ name: 'Home', path: '/', icon: 'home' }].concat(r.content.map(function (p) {
                    return { name: p.name, path: p.path, icon: p.name === 'Music' ? 'music' : p.name === 'Pictures' ? 'image' : p.name === 'Desktop' ? 'grid' : p.name === 'Downloads' ? 'download' : 'folder' };
                })).forEach(function (p) {
                    var b = document.createElement('button');
                    b.type = 'button'; b.className = 'xp-place'; b.dataset.path = p.path;
                    b.innerHTML = ui.icon(p.icon) + '<span class="ellipsis"></span>';
                    b.lastChild.textContent = p.name;
                    b.addEventListener('click', function () { go(p.path); });
                    wireDrop(b, function () { return p.path; });
                    el.appendChild(b);
                });
                highlightPlaces();
            }, function () { });
        }
        function highlightPlaces() {
            rootEl.querySelectorAll('.xp-place').forEach(function (b) { b.classList.toggle('is-active', b.dataset.path === path); });
        }

        // ---------------------------------------------------------------------------------- listing
        function visibleItems() {
            var list = items.filter(function (i) { return showHidden || !i.hidden; });
            if (query && !searching) list = list.filter(function (i) { return i.name.toLowerCase().indexOf(query) >= 0; });
            var k = sort.key;
            list = list.slice().sort(function (a, b) {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                var r = k === 'size' ? a.size - b.size : k === 'mtime' ? a.modification_date - b.modification_date : k === 'ext' ? a.ext.localeCompare(b.ext) : 0;
                return (r || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })) * sort.dir;
            });
            return list;
        }

        var shown = [];
        function render(resetScroll) {
            shown = visibleItems();
            var top = mainEl.scrollTop;
            itemsEl.textContent = '';
            itemsEl.classList.toggle('is-list', view === 'list');
            var frag = document.createDocumentFragment();
            shown.forEach(function (it) { frag.appendChild(buildItem(it)); });
            itemsEl.appendChild(frag);
            emptyEl.hidden = shown.length > 0;
            emptyEl.textContent = searching ? 'No results.' : query ? 'Nothing matches your filter.' : 'This folder is empty. Drop files here to upload.';
            mainEl.scrollTop = resetScroll ? 0 : top;
            updateStatus();
            var sel = itemsEl.querySelector('.is-selected'); if (sel && resetScroll) sel.scrollIntoView({ block: 'nearest' });
        }

        function buildItem(it) {
            var el = document.app.build(DIR + 'UI/item.html', document.createDocumentFragment(), { '${FILE_NAME}': it.name });
            // build() returned the element after moving it into the (temporary) fragment parent
            el.dataset.path = it.path;
            el.title = searching ? it.path : it.name;
            if (searching) el.querySelector('.xp-name').textContent = it.name + '  (' + dirname(it.path) + ')';
            var img = el.querySelector('.xp-icon__img');
            var ext = el.querySelector('.xp-ext');
            var fallback = '/assets/images/default_' + (it.type === 'folder' ? 'folder' : 'file') + '.png';
            if (it.type === 'file' && IMAGE.indexOf(it.ext) >= 0 && it.size <= THUMB_MAX && view === 'grid') {
                img.src = auth.fileUrl(it.path);
                img.classList.add('is-thumb');
                img.addEventListener('error', function () { img.classList.remove('is-thumb'); img.src = fallback; }, { once: true });
            } else {
                img.src = fallback;
                if (it.type === 'file' && it.ext) ext.textContent = it.ext.slice(0, 5);
            }
            el.querySelector('.xp-size').textContent = it.type === 'folder' ? '' : fmtSize(it.size);
            el.querySelector('.xp-date').textContent = fmtDate(it.modification_date);
            el.classList.toggle('is-selected', selected.has(it.path));
            el.setAttribute('aria-selected', String(selected.has(it.path)));
            el.classList.toggle('is-cut', !!clip && clip.mode === 'cut' && clip.paths.indexOf(it.path) >= 0);
            el.classList.toggle('is-hidden-file', it.hidden);
            if (it.type === 'folder') wireDrop(el, function () { return it.path; });
            return el;
        }

        function updateStatus() {
            var n = shown.length, s = selected.size;
            var bytes = shown.filter(function (i) { return selected.has(i.path) && i.type === 'file'; }).reduce(function (a, i) { return a + i.size; }, 0);
            countEl.textContent = n + (n === 1 ? ' item' : ' items') + (s ? ' · ' + s + ' selected' + (bytes ? ' (' + fmtSize(bytes) + ')' : '') : '') + (searching ? ' · search results' : '');
            var has = s > 0, one = s === 1;
            [['cut', has], ['copy', has], ['delete', has], ['rename', one], ['download', one], ['paste', !!clip && !searching]].forEach(function (p) {
                rootEl.querySelector('[data-act=' + p[0] + ']').disabled = !p[1];
            });
            rootEl.querySelector('[data-act=view]').innerHTML = ui.icon(view === 'grid' ? 'list' : 'grid');
        }

        function selection() { return shown.filter(function (i) { return selected.has(i.path); }); }

        function setSelected(paths, keepAnchor) {
            selected = new Set(paths);
            if (!keepAnchor) anchor = paths.length ? paths[paths.length - 1] : null;
            itemsEl.querySelectorAll('.xp-item').forEach(function (el) {
                var on = selected.has(el.dataset.path);
                el.classList.toggle('is-selected', on);
                el.setAttribute('aria-selected', String(on));
            });
            updateStatus();
        }

        // -------------------------------------------------------------------------------- selection
        itemsEl.addEventListener('click', function (e) {
            var el = e.target.closest('.xp-item');
            if (!el) return;
            var p = el.dataset.path;
            if (e.shiftKey && anchor) {
                var a = shown.findIndex(function (i) { return i.path === anchor; }), b = shown.findIndex(function (i) { return i.path === p; });
                setSelected(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (i) { return i.path; }), true);
            } else if (e.ctrlKey || e.metaKey) {
                var next = new Set(selected);
                if (next.has(p)) next.delete(p); else next.add(p);
                anchor = p;
                setSelected(Array.from(next), true);
            } else setSelected([p]);
            if (e.pointerType === 'touch' && !e.ctrlKey) openItem(shown.find(function (i) { return i.path === p; }));
        });
        itemsEl.addEventListener('dblclick', function (e) {
            var el = e.target.closest('.xp-item');
            if (el) openItem(shown.find(function (i) { return i.path === el.dataset.path; }));
        });
        mainEl.addEventListener('click', function (e) { if (e.target === mainEl || e.target === itemsEl || e.target === emptyEl) setSelected([]); });

        function openItem(it) {
            if (!it) return;
            if (it.type === 'folder') { go(it.path); return; }
            apps.openPath(it.path, 'file');
        }

        // ------------------------------------------------------------------------------ operations
        function newEntry(kind) {
            if (searching) return;
            ui.prompt({ title: kind === 'mkdir' ? 'New folder' : 'New file', label: 'Name', value: kind === 'mkdir' ? 'New folder' : 'New file.txt', selectBase: kind === 'mkfile',
                validate: function (v) { return !v ? 'Required' : /[\/\\]/.test(v) ? 'A name cannot contain / or \\' : ''; } }).then(function (name) {
                if (!name) return;
                files.update(kind, { path: path, name: name }).then(function (r) {
                    items = items.concat([]); reloadThenSelect(r.path);
                }, fail);
            });
        }
        function reloadThenSelect(p) {
            files.fetch('listdir', { path: path }).then(function (r) { setItems(r.content); selected = new Set([p]); anchor = p; render(false); var el = itemsEl.querySelector('.is-selected'); if (el) el.scrollIntoView({ block: 'nearest' }); });
        }

        function renameSel() {
            var s = selection();
            if (s.length !== 1) return;
            var it = s[0];
            ui.prompt({ title: 'Rename', label: 'New name', value: it.name, selectBase: it.type === 'file',
                validate: function (v) { return !v ? 'Required' : /[\/\\]/.test(v) ? 'A name cannot contain / or \\' : ''; } }).then(function (name) {
                if (!name || name === it.name) return;
                files.update('rename', { path: it.path, name: name }).then(function (r) { reloadThenSelect(r.path); }, fail);
            });
        }

        function deleteSel() {
            var s = selection();
            if (!s.length) return;
            ui.confirm({ title: 'Delete', message: s.length === 1 ? 'Delete "' + s[0].name + '"? This cannot be undone.' : 'Delete ' + s.length + ' items? This cannot be undone.', confirmText: 'Delete', danger: true }).then(function (ok) {
                if (!ok) return;
                files.update('delete', { paths: s.map(function (i) { return i.path; }) }).then(function () { setSelected([]); reload(); }, fail);
            });
        }

        function setClip(mode) {
            var s = selection();
            if (!s.length) return;
            clip = { mode: mode, paths: s.map(function (i) { return i.path; }) };
            render(false);
            toast((mode === 'cut' ? 'Cut ' : 'Copied ') + s.length + (s.length === 1 ? ' item' : ' items'));
        }
        function paste() {
            if (!clip || searching) return;
            var c = clip;
            files.update(c.mode === 'cut' ? 'move' : 'copy', { paths: c.paths, dest: path }).then(function (r) {
                if (c.mode === 'cut') clip = null;
                reloadThenSelect(r.paths[0]);
            }, fail);
        }

        function download() {
            var s = selection();
            if (s.length !== 1) return;
            var a = document.createElement('a');
            a.href = auth.fileUrl(s[0].path, s[0].type === 'folder' ? { zip: true } : { download: true });
            a.download = '';
            document.body.appendChild(a); a.click(); a.remove();
        }

        function showProperties() {
            var s = selection();
            var it = s.length ? s[0] : null;
            var rows = it ? [['Name', it.name], ['Location', dirname(it.path)], ['Type', it.type === 'folder' ? 'Folder' : (it.ext ? it.ext.toUpperCase() + ' file' : 'File')],
                ['Size', it.type === 'folder' ? '-' : fmtSize(it.size) + ' (' + it.size.toLocaleString() + ' bytes)'], ['Modified', fmtDate(it.modification_date)], ['Created', fmtDate(it.creation_date)]]
                : [['Location', path], ['Items', String(items.length)]];
            ui.dialog({ title: it ? 'Properties' : 'Folder properties', body: '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px">' +
                rows.map(function (r) { return '<span class="muted">' + ui.esc(r[0]) + '</span><span style="word-break:break-all">' + ui.esc(r[1]) + '</span>'; }).join('') + '</div>',
                actions: [{ label: 'Close', value: true, primary: true }] });
        }

        // ------------------------------------------------------------------------------ uploads
        var uploadsActive = 0;
        function setUploadStatus(text, ratio) {
            uploadEl.innerHTML = text ? ui.esc(text) + (ratio != null ? '<span class="xp-progress"><i style="width:' + Math.round(ratio * 100) + '%"></i></span>' : '') : '';
        }

        /** entries: [{ file: File, rel: 'sub/dir/name.ext' }] uploaded below `dest` */
        function uploadAll(entries, dest) {
            if (!entries.length) return;
            var total = entries.reduce(function (a, e) { return a + e.file.size; }, 0) || 1;
            var done = 0, doneBytes = 0, failed = 0, replaceAll = null, current = 0;
            uploadsActive++;
            var next = function (i) {
                if (i >= entries.length || destroyed) return Promise.resolve();
                var e = entries[i];
                var target = joinPath(dest, e.rel);
                var attempt = function (overwrite) {
                    return auth.upload(target, e.file, {
                        overwrite: overwrite, parents: e.rel.indexOf('/') >= 0,
                        onProgress: function (loaded) { current = loaded; setUploadStatus('Uploading ' + (done + 1) + '/' + entries.length + ' - ' + e.file.name, (doneBytes + current) / total); }
                    });
                };
                return attempt(false).catch(function (err) {
                    if (err.status !== 409 || err.code !== 'exists') throw err;
                    var decide = replaceAll !== null ? Promise.resolve(replaceAll) : (function () {
                        var box = document.createElement('div');
                        box.innerHTML = '<p>"' + ui.esc(e.rel) + '" already exists.</p>' + (entries.length - i > 1 ? '<label style="display:flex;gap:6px;margin-top:10px"><input type="checkbox"> Do this for all conflicts</label>' : '');
                        return ui.dialog({ title: 'File exists', body: box, actions: [{ label: 'Skip', value: false }, { label: 'Replace', value: true, primary: true }] }).then(function (v) {
                            var all = box.querySelector('input');
                            if (all && all.checked) replaceAll = !!v;
                            return !!v;
                        });
                    })();
                    return decide.then(function (replace) { return replace ? attempt(true) : null; });
                }).then(function () { done++; doneBytes += e.file.size; current = 0; }, function (err) {
                    failed++; toast(e.file.name + ': ' + ui.errorText(err), 'error');
                }).then(function () { return next(i + 1); });
            };
            setUploadStatus('Uploading…', 0);
            next(0).then(function () {
                uploadsActive--;
                setUploadStatus(uploadsActive ? 'Uploading…' : '', null);
                if (!failed) toast('Uploaded ' + done + (done === 1 ? ' file' : ' files'), 'ok');
                reload();
            });
        }

        $('#xp-file').addEventListener('change', function (e) {
            uploadAll(Array.prototype.map.call(e.target.files, function (f) { return { file: f, rel: f.name }; }), path);
            e.target.value = '';
        });
        $('#xp-folder').addEventListener('change', function (e) {
            uploadAll(Array.prototype.map.call(e.target.files, function (f) { return { file: f, rel: f.webkitRelativePath || f.name }; }), path);
            e.target.value = '';
        });

        /** Walks dropped folders (DataTransferItem.webkitGetAsEntry) into a flat file list. */
        function collect(dataTransfer) {
            var out = [], jobs = [];
            var walk = function (entry, prefix) {
                if (entry.isFile) {
                    jobs.push(new Promise(function (res) { entry.file(function (f) { out.push({ file: f, rel: prefix + f.name }); res(); }, res); }));
                } else if (entry.isDirectory) {
                    jobs.push(new Promise(function (res) {
                        var reader = entry.createReader(), all = [];
                        (function read() {
                            reader.readEntries(function (batch) {
                                if (!batch.length) { Promise.all(all.map(function (c) { return walkAsync(c, prefix + entry.name + '/'); })).then(res); return; }
                                all = all.concat(Array.prototype.slice.call(batch)); read();
                            }, res);
                        })();
                    }));
                }
            };
            var walkAsync = function (entry, prefix) { walk(entry, prefix); return Promise.resolve(); };
            Array.prototype.forEach.call(dataTransfer.items || [], function (item) {
                var entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
                if (entry) walk(entry, '');
                else if (item.kind === 'file') { var f = item.getAsFile(); if (f) out.push({ file: f, rel: f.name }); }
            });
            // directory reads add jobs while running: wait until the queue stops growing
            var settle = function () { var n = jobs.length; return Promise.all(jobs).then(function () { return jobs.length === n ? out : settle(); }); };
            return settle();
        }

        // ------------------------------------------------------------------------ drag and drop
        var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0; };
        var dropEl = $('#xp-drop'), dragDepth = 0;

        mainEl.addEventListener('dragenter', function (e) { if (hasFiles(e)) { dragDepth++; dropEl.hidden = false; } });
        mainEl.addEventListener('dragleave', function (e) { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropEl.hidden = true; } });
        mainEl.addEventListener('dragover', function (e) { if (hasFiles(e) && !e.target.closest('.xp-item')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
        mainEl.addEventListener('drop', function (e) {
            dragDepth = 0; dropEl.hidden = true;
            if (!hasFiles(e) || e.target.closest('.xp-item.is-drop')) return;
            e.preventDefault();
            collect(e.dataTransfer).then(function (list) { if (!searching) uploadAll(list, path); });
        });

        itemsEl.addEventListener('dragstart', function (e) {
            var el = e.target.closest('.xp-item');
            if (!el) return;
            if (!selected.has(el.dataset.path)) setSelected([el.dataset.path]);
            e.dataTransfer.setData('application/x-xp-paths', JSON.stringify(Array.from(selected)));
            e.dataTransfer.effectAllowed = 'copyMove';
        });

        /** makes `el` a drop target for internal moves (or OS files) into the folder returned by getDest() */
        function wireDrop(el, getDest) {
            var accepts = function (e) { return Array.prototype.indexOf.call(e.dataTransfer.types, 'application/x-xp-paths') >= 0 || hasFiles(e); };
            el.addEventListener('dragover', function (e) { if (!accepts(e)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('is-drop'); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; });
            el.addEventListener('dragleave', function () { el.classList.remove('is-drop'); });
            el.addEventListener('drop', function (e) {
                el.classList.remove('is-drop'); dropEl.hidden = true; dragDepth = 0;
                if (!accepts(e)) return;
                e.preventDefault(); e.stopPropagation();
                var dest = getDest();
                var raw = e.dataTransfer.getData('application/x-xp-paths');
                if (raw) {
                    var paths = JSON.parse(raw).filter(function (p) { return p !== dest; });
                    if (!paths.length) return;
                    files.update(e.ctrlKey ? 'copy' : 'move', { paths: paths, dest: dest }).then(function () { setSelected([]); reload(); }, fail);
                } else collect(e.dataTransfer).then(function (list) { uploadAll(list, dest); });
            });
        }

        // --------------------------------------------------------------------------- context menus
        function audioSelection() { var s = selection(); return s.length && s.every(isAudio) ? s : null; }

        function playlistMenu(audio) {
            var addTo = function (p) {
                ensureMusic().then(function (m) { return m.update('song_add', { playlist: p.id, paths: audio.map(function (i) { return i.path; }) }); })
                    .then(function (r) { toast('Added ' + r.added + ' to "' + p.name + '"', 'ok'); }, fail);
            };
            return playlists.map(function (p) { return { label: p.name, icon: 'music', action: function () { addTo(p); } }; })
                .concat(playlists.length ? [{ separator: true }] : [])
                .concat([{ label: 'New playlist…', icon: 'plus', action: function () {
                    ui.prompt({ title: 'New playlist', label: 'Name', value: 'My playlist' }).then(function (name) {
                        if (!name) return;
                        ensureMusic().then(function (m) { return m.update('playlists_create', { name: name }); })
                            .then(function (p) { addTo({ id: p.id, name: p.name }); }, fail);
                    });
                } }]);
        }

        function itemMenu(e) {
            var s = selection(), one = s.length === 1 ? s[0] : null, audio = audioSelection();
            var open = [];
            if (one) {
                open.push({ label: 'Open', icon: 'arrow-right', action: function () { openItem(one); } });
                if (one.type === 'file') open.push({ label: 'Open with', icon: 'code', submenu: [
                    { label: 'Code editor', icon: 'code', action: function () { host.launch('code', { path: one.path }); } },
                    { label: 'Music player', icon: 'music', disabled: !isAudio(one), action: function () { host.launch('music', { play: one.path }); } }
                ] });
                if (one.type === 'folder') open.push({ label: 'Play folder in Music', icon: 'music', action: function () { playFolder(one.path); } });
            }
            if (audio) {
                open.push({ label: 'Play in Music', icon: 'play', action: function () { host.launch('music', audio.length === 1 ? { play: audio[0].path } : { queue: audio.map(function (i) { return i.path; }) }); } });
                open.push({ label: 'Add to playlist', icon: 'playlist', submenu: function () { return ensureMusic().then(function () { return playlistMenu(audio); }); } });
            }
            ui.menu(open.concat([
                open.length ? { separator: true } : null,
                { label: 'Cut', icon: 'scissors', kbd: 'Ctrl+X', action: function () { setClip('cut'); } },
                { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', action: function () { setClip('copy'); } },
                { label: 'Rename', icon: 'pencil', kbd: 'F2', disabled: !one, action: renameSel },
                { label: 'Download' + (one && one.type === 'folder' ? ' as zip' : ''), icon: 'download', disabled: !one, action: download },
                { separator: true },
                { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, action: deleteSel },
                { separator: true },
                { label: 'Properties', icon: 'info', action: showProperties }
            ]), e.clientX, e.clientY);
        }

        function backgroundMenu(e) {
            ui.menu([
                { label: 'New folder', icon: 'folder-plus', disabled: searching, action: function () { newEntry('mkdir'); } },
                { label: 'New file', icon: 'file-plus', disabled: searching, action: function () { newEntry('mkfile'); } },
                { label: 'Paste', icon: 'clipboard', kbd: 'Ctrl+V', disabled: !clip || searching, action: paste },
                { separator: true },
                { label: 'Upload files…', icon: 'upload', disabled: searching, action: function () { $('#xp-file').click(); } },
                { label: 'Upload folder…', icon: 'upload', disabled: searching, action: function () { $('#xp-folder').click(); } },
                { separator: true },
                { label: showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'info', kbd: 'Ctrl+H', action: toggleHidden },
                { label: 'Refresh', icon: 'refresh', kbd: 'F5', action: reload },
                { label: 'Properties', icon: 'info', action: function () { setSelected([]); showProperties(); } }
            ], e.clientX, e.clientY);
        }

        mainEl.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var el = e.target.closest('.xp-item');
            if (el) { if (!selected.has(el.dataset.path)) setSelected([el.dataset.path]); itemMenu(e); }
            else { setSelected([]); backgroundMenu(e); }
        });

        function playFolder(folder) {
            files.fetch('listdir', { path: folder }).then(function (r) {
                var songs = r.content.filter(isAudio).map(function (i) { return i.path; });
                if (!songs.length) return toast('No audio files in this folder.');
                host.launch('music', { queue: songs });
            }, fail);
        }

        function toggleHidden() { showHidden = !showHidden; localStorage.setItem('xp.hidden', showHidden ? '1' : '0'); render(false); }

        // ----------------------------------------------------------------------------- toolbar + keys
        rootEl.addEventListener('click', function (e) {
            var b = e.target.closest('[data-act]');
            if (!b || b.disabled) return;
            ({
                back: function () { if (back.length) { forward.push(path); go(back.pop(), { push: false }); } },
                forward: function () { if (forward.length) { back.push(path); go(forward.pop(), { push: false }); } },
                up: function () { if (path !== '/') go(dirname(path)); },
                refresh: reload,
                mkdir: function () { newEntry('mkdir'); }, mkfile: function () { newEntry('mkfile'); },
                upload: function () { $('#xp-file').click(); },
                cut: function () { setClip('cut'); }, copy: function () { setClip('copy'); }, paste: paste,
                rename: renameSel, download: download, 'delete': deleteSel,
                view: function () { view = view === 'grid' ? 'list' : 'grid'; localStorage.setItem('xp.view', view); render(false); }
            })[b.dataset.act]();
        });

        sortEl.value = sort.key;
        sortEl.addEventListener('change', function () { sort.key = sortEl.value; localStorage.setItem('xp.sort', sort.key); render(false); });

        var searchTimer = null;
        searchEl.addEventListener('input', function () {
            clearTimeout(searchTimer);
            var q = searchEl.value.trim().toLowerCase();
            searchTimer = setTimeout(function () {
                query = q;
                if (q.length < 2) { if (searching) { searching = false; reload(); } else render(false); return; }
                var seq = ++searchSeq;
                // instant filter of the current folder, then a deep search below it
                render(false);
                files.fetch('search', { path: path, query: q }).then(function (r) {
                    if (seq !== searchSeq || !searchEl.value.trim()) return;
                    searching = true; items = r.content; selected.clear();
                    render(true);
                    if (r.truncated) toast('Showing the first results only; refine your search.');
                }, fail);
            }, 250);
        });
        searchEl.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); searchEl.value = ''; query = ''; var was = searching; searching = false; was ? reload() : render(false); rootEl.focus(); }
        });

        rootEl.addEventListener('keydown', function (e) {
            if (e.target.closest('input, select, textarea')) return;
            var mod = e.ctrlKey || e.metaKey, k = e.key;
            if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setSelected(shown.map(function (i) { return i.path; })); }
            else if (mod && k.toLowerCase() === 'c') { e.preventDefault(); setClip('copy'); }
            else if (mod && k.toLowerCase() === 'x') { e.preventDefault(); setClip('cut'); }
            else if (mod && k.toLowerCase() === 'v') { e.preventDefault(); paste(); }
            else if (mod && k.toLowerCase() === 'l') { e.preventDefault(); editPath(); }
            else if (mod && k.toLowerCase() === 'f') { e.preventDefault(); searchEl.focus(); }
            else if (mod && k.toLowerCase() === 'h') { e.preventDefault(); toggleHidden(); }
            else if (k === 'Delete') { e.preventDefault(); deleteSel(); }
            else if (k === 'F2') { e.preventDefault(); renameSel(); }
            else if (k === 'F5') { e.preventDefault(); reload(); }
            else if (k === 'Enter') { var s = selection(); if (s.length === 1) openItem(s[0]); else s.forEach(function (i) { if (i.type === 'file') openItem(i); }); }
            else if (k === 'Backspace' || (e.altKey && k === 'ArrowUp')) { e.preventDefault(); rootEl.querySelector('[data-act=up]').click(); }
            else if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); rootEl.querySelector('[data-act=back]').click(); }
            else if (e.altKey && k === 'ArrowRight') { e.preventDefault(); rootEl.querySelector('[data-act=forward]').click(); }
            else if (k === 'Escape') { setSelected([]); }
            else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(k) >= 0 && shown.length) {
                e.preventDefault();
                var idx = shown.findIndex(function (i) { return i.path === anchor; });
                var cols = view === 'list' ? 1 : Math.max(1, Math.floor(itemsEl.clientWidth / (itemsEl.firstChild ? itemsEl.firstChild.offsetWidth + 6 : 100)));
                var to = k === 'Home' ? 0 : k === 'End' ? shown.length - 1 : idx < 0 ? 0 : idx + (k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -cols : cols);
                to = Math.max(0, Math.min(shown.length - 1, to));
                if (e.shiftKey && idx >= 0) setSelected(shown.slice(Math.min(idx, to), Math.max(idx, to) + 1).map(function (i) { return i.path; }), true);
                else setSelected([shown[to].path]);
                anchor = shown[to].path;
                var el = Array.prototype.find.call(itemsEl.children, function (n) { return n.dataset.path === anchor; });
                if (el) el.scrollIntoView({ block: 'nearest' });
            }
        });
        rootEl.addEventListener('pointerdown', function (e) { if (!e.target.closest('input, select, textarea, button')) rootEl.focus({ preventScroll: true }); });

        function onHash() { if (standalone && !destroyed && files) { var h = decodeURIComponent(location.hash.slice(1)); if (h && normalize(h) !== path) go(h, { push: true }); } }
        if (standalone) window.addEventListener('hashchange', onHash);

        updateStatus();
        renderPath();

        return {
            /** another app asked us to show something: { path } */
            handleIntent: function (args) { if (args && args.path && files) go(args.path, { reveal: true }); },
            nonStandaloneDestroy: function () {
                destroyed = true;
                clearTimeout(reloadTimer); clearTimeout(searchTimer);
                window.removeEventListener('hashchange', onHash);
                if (files) files.close();
                if (music) music.close();
            }
        };
    };
})();
