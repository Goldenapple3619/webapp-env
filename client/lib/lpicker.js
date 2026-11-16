var __pick = (() => {
    var handle = null;
    function files() {
        if (!handle) handle = document.wsscon.app('explorer');
        return handle;
    }
    function parentOf(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }

    function path(opts) {
        opts = opts || {};
        var kind = opts.kind === 'folder' ? 'folder' : 'file';
        var exts = (opts.exts || []).map(function (e) { return String(e).toLowerCase(); });
        var cwd = '/', selected = null;
        if (opts.value && opts.value.charAt(0) === '/') cwd = kind === 'folder' ? opts.value : parentOf(opts.value);
        else if (opts.start) cwd = opts.start;
        if (opts.value && kind === 'file') selected = opts.value;

        var root = __ui.el('div', 'pk');
        root.innerHTML = '<div class="pk-bar"><button type="button" class="btn btn--sm btn--icon" data-up title="Up" aria-label="Up">' + __ui.icon('arrow-up') +
            '</button><input class="input" data-path spellcheck="false" autocomplete="off" aria-label="Location"></div>' +
            '<div class="pk-list" role="listbox" tabindex="0"></div>';
        var pathInput = root.querySelector('[data-path]'), list = root.querySelector('.pk-list');

        return __ui.dialog({
            title: opts.title || (kind === 'folder' ? 'Choose a folder' : 'Choose a file'), wide: true, body: root,
            actions: [{ label: 'Cancel', value: null }, { label: kind === 'folder' ? 'Choose this folder' : 'Choose', value: '__ok__', primary: true }],
            onOpen: function (box, done) {
                var okBtn = box.querySelector('.btn--primary');
                function sync() {
                    pathInput.value = kind === 'file' && selected ? selected : cwd;
                    okBtn.disabled = kind === 'file' && !selected;
                    list.querySelectorAll('.pk-item').forEach(function (n) { n.classList.toggle('is-selected', n.dataset.path === selected); n.setAttribute('aria-selected', n.dataset.path === selected); });
                }
                function render(entries) {
                    list.textContent = '';
                    var shown = entries.filter(function (e) {
                        if (e.hidden) return false;
                        return e.type === 'folder' || (kind === 'file' && (!exts.length || exts.indexOf(e.ext) >= 0));
                    });
                    shown.sort(function (a, b) { return (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
                    if (!shown.length) list.appendChild(__ui.el('div', 'pk-empty', kind === 'file' && exts.length ? 'No ' + __ui.esc(exts.join(' / ')) + ' files here' : 'Empty folder'));
                    shown.forEach(function (e) {
                        var row = __ui.el('div', 'pk-item', __ui.icon(e.type === 'folder' ? 'folder' : 'file') + '<span class="ellipsis"></span>' + (e.type === 'folder' ? '' : '<span class="ext">' + __ui.esc(e.ext) + '</span>'));
                        row.querySelector('.ellipsis').textContent = e.name;
                        row.setAttribute('role', 'option');
                        row.dataset.path = e.path;
                        row.addEventListener('click', function () { selected = e.type === 'folder' && kind === 'file' ? selected : e.path; sync(); });
                        row.addEventListener('dblclick', function () {
                            if (e.type === 'folder') go(e.path);
                            else if (kind === 'file') done({ path: e.path });
                        });
                        list.appendChild(row);
                    });
                    sync();
                }
                function go(target) {
                    files().then(function (h) { return h.fetch('listdir', { path: target }); }).then(function (r) {
                        cwd = r.fetched || target;
                        if (kind === 'folder') selected = cwd;
                        render(r.content || []);
                    }).catch(function (err) { __ui.toast(__ui.errorText(err), 'error'); });
                }
                box.querySelector('[data-up]').addEventListener('click', function () { go(parentOf(cwd)); });
                pathInput.addEventListener('keydown', function (e) {
                    if (e.key !== 'Enter') return;
                    e.preventDefault(); e.stopPropagation();
                    var v = pathInput.value.trim();
                    if (v.charAt(0) === '/') go(kind === 'file' && /\.[^/.]+$/.test(v) ? parentOf(v) : v);
                });
                okBtn.addEventListener('click', function (e) {
                    e.stopImmediatePropagation();
                    var v = kind === 'folder' ? cwd : selected;
                    if (v) done({ path: v });
                }, true);
                go(cwd);
            }
        }).then(function (r) { return r && r.path ? r.path : null; });
    }

    return ({ path: path });
})();
