(async function () {
    const $ = (id) => document.getElementById(id);
    const msg = (text, err) => { $('msg').textContent = text || ''; $('msg').className = err ? 'err' : ''; };

    async function render() {
        const s = await window.suite.state();
        $('version').textContent = 'v' + s.version + ' · ' + s.platform;
        $('url').value = s.server;
        $('apps').hidden = !s.server;
        if (s.server) {
            const grid = $('grid');
            grid.textContent = '';
            s.apps.forEach((a) => {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = a.name;
                b.addEventListener('click', () => window.suite.openApp(a.id));
                grid.appendChild(b);
            });
            msg(s.insecure ? 'Warning: this server is not using HTTPS. Your password and files travel unencrypted.' : 'Connected to ' + s.server, s.insecure);
        } else msg('Enter the address of your server to begin.');
    }

    $('server').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('connect').disabled = true; msg('Checking…');
        const r = await window.suite.setServer($('url').value);
        $('connect').disabled = false;
        if (!r.ok) return msg(r.error, true);
        render();
    });
    $('desktop').addEventListener('click', () => window.suite.openDesktop());
    $('quit').addEventListener('click', () => window.suite.quit());
    window.suite.onState(render);
    render();
})();
