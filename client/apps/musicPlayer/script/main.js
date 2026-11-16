(function () {
    var auth = __auth.getInstance();
    var DIR = '/apps/musicPlayer/';

    // default cover: a note on the window-frame gradient (inline, no extra request)
    var DEFAULT_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FC9DC9"/><stop offset="1" stop-color="#BBA1F0"/></linearGradient></defs>' +
        '<rect width="200" height="200" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity=".9"><path d="M80 138V62l56-12v74"/><circle cx="64" cy="140" r="16"/><circle cx="120" cy="126" r="16"/></g></svg>');

    function fmtTime(t) {
        if (!isFinite(t) || t < 0) return '0:00';
        var s = Math.floor(t), m = Math.floor(s / 60);                 // floor: 59.6s used to show "0:60"
        return m + ':' + String(s % 60).padStart(2, '0');
    }
    function basename(p) { return p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''); }

    document.createMusicEngine = createEngine;      // exposed so the queue / error / repeat logic can be tested without a browser audio stack
    function createEngine(onChange) {
        var audio = new Audio();
        audio.preload = 'metadata';
        var queue = [], index = -1, order = [], shuffle = false, repeat = 'off';   // repeat: off | all | one
        var retried = false, failures = 0;   // failures: tracks in a row that could not play (stops the skip-on-error chain)

        function buildOrder(keepCurrent) {   // (also called when "repeat all" wraps around: it must NOT reset the failure streak)
            order = queue.map(function (_, i) { return i; });
            if (shuffle) {
                for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
                if (keepCurrent && index >= 0) { order.splice(order.indexOf(index), 1); order.unshift(index); }
            }
        }
        function pos() { return order.indexOf(index); }
        function emit(what) { if (onChange) onChange(what || 'state'); }

        function load(i, autoplay) {
            if (i < 0 || i >= queue.length) return;
            index = i; retried = false;
            audio.src = auth.fileUrl(queue[i].path);
            audio.load();
            emit('track');
            if (autoplay) audio.play().catch(function () { emit('state'); });
        }

        audio.addEventListener('ended', function () {
            if (repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
            api.next(true);
        });
        audio.addEventListener('playing', function () { failures = 0; });
        ['play', 'pause', 'playing', 'waiting'].forEach(function (e) { audio.addEventListener(e, function () { emit('state'); }); });
        audio.addEventListener('timeupdate', function () { emit('time'); });
        audio.addEventListener('loadedmetadata', function () { emit('time'); });
        audio.addEventListener('error', function () {
            // the access cookie may have lapsed while paused: renew once and resume where we were
            if (!retried && index >= 0) {
                retried = true;
                var at = audio.currentTime, was = !audio.paused;
                auth.refresh().catch(function () { }).then(function () {
                    audio.src = auth.fileUrl(queue[index].path);
                    audio.addEventListener('loadedmetadata', function once() { audio.removeEventListener('loadedmetadata', once); audio.currentTime = at; if (was) audio.play().catch(function () { }); });
                    audio.load();
                });
                return;
            }
            emit('error');
            // skip to the next song - but only until every song of the queue has failed once in a row; with "repeat all" and a dead
            // connection this used to loop through the queue forever, hammering the server
            failures++;
            if (queue.length > 1 && failures < queue.length) api.next(true);
        });

        var api = {
            audio: audio,
            setQueue: function (tracks, start, autoplay, label) {
                failures = 0;
                queue = tracks.filter(function (t) { return !t.missing; });
                api.label = label || '';
                buildOrder(false);
                if (!queue.length) { index = -1; audio.removeAttribute('src'); audio.load(); emit('track'); return; }
                var s = Math.max(0, Math.min(start || 0, queue.length - 1));
                if (shuffle) { index = s; buildOrder(true); }
                load(s, autoplay);
            },
            current: function () { return queue[index] || null; },
            queue: function () { return queue; },
            playIndex: function (i) { failures = 0; load(i, true); },   // an explicit choice starts a fresh streak
            toggle: function () { if (index < 0) return; audio.paused ? audio.play().catch(function () { }) : audio.pause(); },
            next: function (auto) {
                if (!queue.length) return;
                var p = pos() + 1;
                if (p >= order.length) { if (repeat === 'all' || !auto) { buildOrder(false); p = 0; } else { audio.pause(); audio.currentTime = 0; emit('state'); return; } }
                load(order[p], true);
            },
            prev: function () {
                if (!queue.length) return;
                if (audio.currentTime > 3) { audio.currentTime = 0; return; }
                var p = pos() - 1;
                load(order[p < 0 ? order.length - 1 : p], true);
            },
            seekRatio: function (r) { if (isFinite(audio.duration)) audio.currentTime = audio.duration * r; },
            seekBy: function (s) { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + s)); },
            setVolume: function (v) { audio.volume = Math.max(0, Math.min(1, v)); if (v > 0) audio.muted = false; emit('volume'); },
            toggleMute: function () { audio.muted = !audio.muted; emit('volume'); },
            setShuffle: function (on) { shuffle = on; buildOrder(true); emit('mode'); },
            cycleRepeat: function () { repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'; emit('mode'); },
            getMode: function () { return { shuffle: shuffle, repeat: repeat }; },
            destroy: function () { audio.pause(); audio.removeAttribute('src'); audio.load(); }
        };
        api.label = '';
        return api;
    }

    document.setupApp = document.setupApp || {};
    document.setupApp.musicPlayer = function (parent, standalone, UIs, onConnect, options) {
        options = options || {};
        var host = options.host || { setTitle: function () { } };
        var ws = document.wsscon;
        var ui = __ui;

        var rootEl = document.app.build(DIR + 'UI/main.html', parent);
        var $ = function (s) { return rootEl.querySelector(s); };
        var destroyed = false;
        var handle = null, playlists = [], library = null, libraryStale = true;
        var open = {};                                    // expanded playlists (id -> true)
        var tab = 'playlists', filter = '';
        var playingFrom = null;                           // 'pl:<id>' | 'library' | 'adhoc'

        function fail(e) { ui.toast(ui.errorText(e), 'error'); }
        var track = function (p) { return { name: basename(p), path: p }; };
        var fromSong = function (s) { return { name: s.name, path: s.endpoint, cover: s.cover, missing: s.missing, id: s.id }; };

        var engine = createEngine(function (what) {
            if (what === 'time') return paintTime();
            paintAll();
            if (what === 'track') { paintList(); updateMediaSession(); }
        });
        var seeking = false;

        function setFill(input) { input.style.setProperty('--fill', (input.max > 0 ? (input.value / input.max) * 100 : 0) + '%'); }
        function setIcon(btn, name) { btn.querySelector('use').setAttribute('href', '/assets/images/icons.svg#' + name); }

        function paintTime() {
            var a = engine.audio, seek = $('#mp-seek');
            $('#mp-cur').textContent = fmtTime(a.currentTime);
            $('#mp-dur').textContent = fmtTime(a.duration);
            if (!seeking) { seek.value = a.duration ? Math.round((a.currentTime / a.duration) * 1000) : 0; setFill(seek); }
            if ('mediaSession' in navigator && isFinite(a.duration) && a.duration > 0) {
                try { navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate }); } catch (e) { /* ignore */ }
            }
        }

        function paintAll() {
            var t = engine.current(), a = engine.audio, mode = engine.getMode();
            $('#mp-title').textContent = t ? t.name : 'Nothing playing';
            $('#mp-sub').textContent = t ? (engine.label || 'Unknown album') : 'Pick a song from your library';
            var cover = $('#mp-cover');
            var src = t && t.cover ? auth.fileUrl(t.cover) : DEFAULT_COVER;
            if (cover.dataset.src !== src) {
                cover.dataset.src = src; cover.src = src;
                cover.onerror = function () { cover.onerror = null; cover.src = DEFAULT_COVER; };
            }
            var play = $('#mp-play');
            setIcon(play, a.paused ? 'play' : 'pause');
            play.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
            $('#mp-seek').disabled = !t;
            var shuf = $('#mp-shuffle'), rep = $('#mp-repeat');
            shuf.setAttribute('aria-pressed', String(mode.shuffle));
            rep.setAttribute('aria-pressed', String(mode.repeat !== 'off'));
            rep.title = 'Repeat: ' + mode.repeat;
            setIcon(rep, mode.repeat === 'one' ? 'repeat-1' : 'repeat');
            var vol = $('#mp-volume'), v = a.muted ? 0 : a.volume;
            vol.value = Math.round(v * 100); setFill(vol);
            setIcon($('#mp-mute'), v === 0 ? 'volume-x' : v < 0.34 ? 'volume-0' : v < 0.67 ? 'volume-1' : 'volume-2');
            host.setTitle(t ? t.name : '');
            paintTime();
        }

        // seek, volume, buttons
        var seekEl = $('#mp-seek');
        seekEl.addEventListener('pointerdown', function () {
            seeking = true;
            // 'change' does not fire when the thumb is pressed and released without moving: that left `seeking` true for good and froze the bar
            var release = function () { seeking = false; document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); };
            document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
        });
        seekEl.addEventListener('input', function () { setFill(seekEl); $('#mp-cur').textContent = fmtTime((seekEl.value / 1000) * (engine.audio.duration || 0)); });
        seekEl.addEventListener('change', function () { engine.seekRatio(seekEl.value / 1000); seeking = false; });
        var volEl = $('#mp-volume');
        var savedVol = parseFloat(localStorage.getItem('mp.volume'));
        engine.audio.volume = isFinite(savedVol) ? savedVol : 0.8;
        volEl.addEventListener('input', function () { engine.setVolume(volEl.value / 100); localStorage.setItem('mp.volume', String(engine.audio.volume)); });
        $('#mp-mute').addEventListener('click', engine.toggleMute);
        $('#mp-play').addEventListener('click', engine.toggle);
        $('#mp-next').addEventListener('click', function () { engine.next(false); });
        $('#mp-prev').addEventListener('click', engine.prev);
        $('#mp-shuffle').addEventListener('click', function () { engine.setShuffle(!engine.getMode().shuffle); });
        $('#mp-repeat').addEventListener('click', engine.cycleRepeat);
        rootEl.addEventListener('keydown', function (e) {
            if (e.target.closest('input[type=search], input[type=text]')) return;
            if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); engine.toggle(); }
            else if (e.key === 'm' || e.key === 'M') engine.toggleMute();
            else if (e.key === 'ArrowRight' && e.altKey) engine.next(false);
            else if (e.key === 'ArrowLeft' && e.altKey) engine.prev();
        });

        function updateMediaSession() {
            if (!('mediaSession' in navigator)) return;
            var t = engine.current();
            if (!t) { navigator.mediaSession.metadata = null; return; }
            var art = t.cover ? new URL(auth.fileUrl(t.cover), location.href).href : null;
            navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: '', album: engine.label || '', artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
        }
        if ('mediaSession' in navigator) {
            var set = function (n, f) { try { navigator.mediaSession.setActionHandler(n, f); } catch (e) { /* unsupported */ } };
            set('play', engine.toggle); set('pause', engine.toggle);
            set('previoustrack', engine.prev); set('nexttrack', function () { engine.next(false); });
            set('seekbackward', function () { engine.seekBy(-10); }); set('seekforward', function () { engine.seekBy(10); });
            set('seekto', function (d) { engine.audio.currentTime = d.seekTime; });
        }

        function loadPlaylists() { return handle.fetch('playlists').then(function (r) { playlists = r.content; paintList(); }, fail); }
        function loadLibrary() { return handle.fetch('library').then(function (r) { library = r.content; libraryStale = false; if (r.truncated) ui.toast('Library truncated to the first files.'); paintList(); }, fail); }

        ws.app('music').then(function (h) {
            if (destroyed) return h.close();
            handle = h;
            if (onConnect) onConnect(h.sessionId);
            h.on('restore', function () { loadPlaylists(); libraryStale = true; if (tab === 'library') loadLibrary(); });
            h.on('playlists_changed', loadPlaylists);
            h.on('library_changed', function () { libraryStale = true; if (tab === 'library' && !rootEl.querySelector('#mp-library').hidden) loadLibrary(); });
            return loadPlaylists().then(function () { return handleIntent(options.args || {}); });
        }, fail);

        function playTracks(tracks, start, label, from) {
            playingFrom = from;
            engine.setQueue(tracks, start, true, label);
        }

        // "play this file": inside the library if we know it, otherwise as a one-song queue
        function handleIntent(args) {
            if (!args) return Promise.resolve();
            var queue = [].concat(args.queue || []).filter(Boolean);   // one <arg name="queue"> arrives as a string, several as a list
            if (queue.length) { playTracks(queue.map(track), 0, 'Queue', 'adhoc'); return Promise.resolve(); }
            if (args.play) {
                return (library ? Promise.resolve() : loadLibrary()).then(function () {
                    var folder = args.play.slice(0, args.play.lastIndexOf('/')) || '/';
                    var siblings = (library || []).filter(function (f) { return (f.path.slice(0, f.path.lastIndexOf('/')) || '/') === folder; });
                    var at = siblings.findIndex(function (f) { return f.path === args.play; });
                    if (at >= 0) playTracks(siblings.map(function (f) { return { name: f.name, path: f.path, cover: f.cover }; }), at, folder === '/' ? 'Home' : folder.split('/').pop(), 'adhoc');
                    else playTracks([track(args.play)], 0, '', 'adhoc');
                });
            }
            return Promise.resolve();
        }

        var listEl = $('#mp-list');

        function currentPath() { var t = engine.current(); return t && t.path; }

        function paintList() {
            if (rootEl.querySelector('#mp-library').hidden) return;
            var f = filter.toLowerCase();
            listEl.textContent = '';
            if (tab === 'playlists') {
                if (!playlists.length) { listEl.innerHTML = '<div class="mp-empty">No playlists yet.<br>Create one, then add songs from your library.</div>'; return; }
                playlists.filter(function (p) { return !f || p.name.toLowerCase().indexOf(f) >= 0 || p.songs.some(function (s) { return s.name.toLowerCase().indexOf(f) >= 0; }); }).forEach(function (p) { listEl.appendChild(buildPlaylist(p)); });
            } else {
                if (libraryStale && !library) { listEl.innerHTML = '<div class="mp-empty">Scanning your files…</div>'; return; }
                var rows = (library || []).filter(function (s) { return !f || s.name.toLowerCase().indexOf(f) >= 0 || s.path.toLowerCase().indexOf(f) >= 0; });
                if (!rows.length) { listEl.innerHTML = '<div class="mp-empty">' + (library && library.length ? 'No match.' : 'No audio files found.<br>Upload mp3, ogg, wav, flac, m4a, aac or opus files with the Explorer.') + '</div>'; return; }
                var frag = document.createDocumentFragment();
                rows.forEach(function (s, i) { frag.appendChild(buildLibraryRow(s, rows)); });
                listEl.appendChild(frag);
            }
        }

        function iconBtn(name, title, cls, fn) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn--ghost btn--icon btn--sm' + (cls ? ' ' + cls : '');
            b.title = title; b.setAttribute('aria-label', title);
            b.innerHTML = ui.icon(name);
            b.addEventListener('click', function (e) { e.stopPropagation(); fn(e); });
            return b;
        }

        function buildPlaylist(p) {
            var el = document.createElement('div');
            el.className = 'mp-pl' + (open[p.id] ? ' is-open' : '');
            var head = document.createElement('div');
            head.className = 'mp-pl__head';
            var toggle = document.createElement('button');
            toggle.type = 'button'; toggle.className = 'name';
            toggle.innerHTML = '<span class="chev" style="display:inline-block;transition:transform .12s">' + ui.icon('chevron-right') + '</span> <span></span> <small></small>';
            toggle.children[1].textContent = p.name;
            toggle.children[2].textContent = '(' + p.songs.length + ')';
            toggle.addEventListener('click', function () { open[p.id] = !open[p.id]; el.classList.toggle('is-open', open[p.id]); });
            head.appendChild(toggle);
            head.appendChild(iconBtn('play', 'Play playlist', '', function () { playPlaylist(p, 0); }));
            head.appendChild(iconBtn('plus', 'Add songs', '', function () { pickSongs(p); }));
            head.appendChild(iconBtn('pencil', 'Rename', '', function () { renamePlaylist(p); }));
            head.appendChild(iconBtn('trash', 'Delete playlist', 'btn--danger', function () { deletePlaylist(p); }));
            el.appendChild(head);

            var songs = document.createElement('div');
            songs.className = 'mp-songs';
            if (!p.songs.length) songs.innerHTML = '<div class="mp-empty" style="padding:10px">Empty. Use + to add songs.</div>';
            p.songs.forEach(function (s, i) {
                var row = document.createElement('div');
                row.className = 'mp-song' + (s.missing ? ' is-missing' : '') + (!s.missing && playingFrom === 'pl:' + p.id && currentPath() === s.endpoint ? ' is-current' : '');
                row.innerHTML = '<span class="idx"></span><button class="title ellipsis" type="button"></button><span class="acts"></span>';
                row.querySelector('.idx').textContent = i + 1;
                var title = row.querySelector('.title');
                title.textContent = s.name; title.title = s.missing ? 'File not found: ' + s.endpoint : s.endpoint;
                title.addEventListener('click', function () { if (!s.missing) playPlaylist(p, i); });
                var acts = row.querySelector('.acts');
                acts.appendChild(iconBtn('arrow-up', 'Move up', '', function () { if (i > 0) moveSong(p, s, i - 1); }));
                acts.appendChild(iconBtn('arrow-down', 'Move down', '', function () { if (i < p.songs.length - 1) moveSong(p, s, i + 1); }));
                acts.appendChild(iconBtn('x', 'Remove from playlist', 'btn--danger', function () { handle.update('song_delete', { playlist: p.id, id: s.id }).then(loadPlaylists, fail); }));
                songs.appendChild(row);
            });
            el.appendChild(songs);
            return el;
        }

        function buildLibraryRow(s, rows) {
            var row = document.createElement('div');
            row.className = 'mp-song' + (playingFrom === 'library' && currentPath() === s.path ? ' is-current' : '');
            row.innerHTML = '<span class="idx">' + ui.icon('music') + '</span><button class="title ellipsis" type="button"></button><span class="acts" style="opacity:1"></span>';
            var title = row.querySelector('.title');
            title.textContent = s.name; title.title = s.path;
            title.addEventListener('click', function () {
                playTracks(rows.map(function (r) { return { name: r.name, path: r.path, cover: r.cover }; }), rows.indexOf(s), 'Library', 'library');
            });
            row.querySelector('.acts').appendChild(iconBtn('playlist', 'Add to playlist', '', function (e) {
                var r = e.currentTarget.getBoundingClientRect();
                ui.menu(playlists.map(function (p) { return { label: p.name, icon: 'music', action: function () { addSongs(p, [s.path]); } }; })
                    .concat(playlists.length ? [{ separator: true }] : []).concat([{ label: 'New playlist…', icon: 'plus', action: function () { createPlaylist().then(function (p) { if (p) addSongs(p, [s.path]); }); } }]), r.left, r.bottom);
            }));
            return row;
        }

        function playPlaylist(p, start) {
            var tracks = p.songs.map(fromSong);
            // `start` indexes the visible list; engine drops missing songs, so map it
            var target = tracks[start];
            var playable = tracks.filter(function (t) { return !t.missing; });
            playTracks(playable, Math.max(0, playable.indexOf(target)), p.name, 'pl:' + p.id);
        }
        function createPlaylist() {
            return ui.prompt({ title: 'New playlist', label: 'Name', value: 'My playlist' }).then(function (name) {
                if (!name) return null;
                return handle.update('playlists_create', { name: name }).then(function (r) { open[r.id] = true; return loadPlaylists().then(function () { return { id: r.id, name: r.name }; }); }, function (e) { fail(e); return null; });
            });
        }
        function renamePlaylist(p) {
            ui.prompt({ title: 'Rename playlist', label: 'Name', value: p.name }).then(function (name) {
                if (name && name !== p.name) handle.update('playlists_rename', { id: p.id, name: name }).then(loadPlaylists, fail);
            });
        }
        function deletePlaylist(p) {
            ui.confirm({ title: 'Delete playlist', message: 'Delete "' + p.name + '"? Your music files are not deleted.', confirmText: 'Delete', danger: true }).then(function (ok) {
                if (ok) handle.update('playlists_delete', { id: p.id }).then(loadPlaylists, fail);
            });
        }
        function moveSong(p, s, position) { handle.update('song_move', { playlist: p.id, id: s.id, position: position }).then(loadPlaylists, fail); }
        function addSongs(p, paths) {
            return handle.update('song_add', { playlist: p.id, paths: paths }).then(function (r) { ui.toast('Added ' + r.added + ' to "' + p.name + '"', 'ok'); open[p.id] = true; return loadPlaylists(); }, fail);
        }

        function pickSongs(p) {
            (library ? Promise.resolve() : loadLibrary()).then(function () {
                var box = document.createElement('div');
                box.innerHTML = '<input class="input" type="search" placeholder="Filter songs" aria-label="Filter songs"><div class="mp-pick"></div>';
                var pick = box.querySelector('.mp-pick'), filt = box.querySelector('input');
                var have = new Set(p.songs.map(function (s) { return s.endpoint; }));
                var render = function () {
                    var q = filt.value.toLowerCase();
                    pick.textContent = '';
                    (library || []).filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) >= 0 || s.path.toLowerCase().indexOf(q) >= 0; }).forEach(function (s) {
                        var l = document.createElement('label');
                        l.innerHTML = '<input type="checkbox"> <span class="ellipsis"></span>';
                        l.querySelector('span').textContent = s.name + (have.has(s.path) ? '  (already in playlist)' : '');
                        var cb = l.querySelector('input'); cb.value = s.path; cb.checked = pick._sel && pick._sel.has(s.path);
                        cb.addEventListener('change', function () { pick._sel = pick._sel || new Set(); cb.checked ? pick._sel.add(s.path) : pick._sel.delete(s.path); });
                        pick.appendChild(l);
                    });
                    if (!pick.children.length) pick.innerHTML = '<div class="mp-empty">No audio files found.</div>';
                };
                filt.addEventListener('input', render);
                render();
                ui.dialog({ title: 'Add to "' + p.name + '"', body: box, wide: false, actions: [{ label: 'Cancel', value: null }, { label: 'Add selected', value: true, primary: true }] }).then(function (ok) {
                    if (ok && pick._sel && pick._sel.size) addSongs(p, Array.from(pick._sel));
                });
            });
        }

        var libEl = $('#mp-library');
        function showLibrary(show) {
            libEl.hidden = !show;
            if (show) { if (tab === 'library' && libraryStale) loadLibrary(); paintList(); }
        }
        $('#mp-open-library').addEventListener('click', function () { showLibrary(true); });
        $('#mp-back').addEventListener('click', function () { showLibrary(false); });
        libEl.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !e.target.closest('.ui-overlay')) { e.stopPropagation(); showLibrary(false); } });
        libEl.querySelector('.mp-tabs').addEventListener('click', function (e) {
            var b = e.target.closest('[data-tab]');
            if (!b) return;
            tab = b.dataset.tab;
            libEl.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('is-active', x === b); x.setAttribute('aria-selected', String(x === b)); });
            $('#mp-new').hidden = tab !== 'playlists';
            if (tab === 'library' && libraryStale) loadLibrary(); else paintList();
        });
        $('#mp-filter').addEventListener('input', function (e) { filter = e.target.value.trim(); paintList(); });
        $('#mp-new').addEventListener('click', createPlaylist);

        paintAll();

        return {
            handleIntent: function (args) { return handleIntent(args); },
            getEngine: function () { return engine; },
            nonStandaloneDestroy: function () {
                destroyed = true;
                engine.destroy();
                if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
                if (handle) handle.close();
            }
        };
    };
})();
