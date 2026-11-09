/**
 * Settings window: account (change password), sessions (see / sign out devices), connection status.
 * This is the user interface of the session system.
 */
(function () {
    var auth = __auth.getInstance();
    var esc = __ui.esc, icon = __ui.icon;
    document.desktopState = document.desktopState || {};

    function describeAgent(ua) {
        ua = ua || '';
        var os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
        var br = /Electron/i.test(ua) ? 'Desktop app' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown client';
        return br + (os ? ' on ' + os : '');
    }
    function ago(date) {
        var s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        return Math.floor(s / 86400) + ' d ago';
    }

    var win = null;

    document.desktopState.openSettings = function (tab) {
        if (win) { win.focus(); if (tab) win._show(tab); return; }
        var wm = document.getElementById('wm');
        var unsubscribe = null;
        win = __window.new('Settings', [600, 520], wm, function () { if (unsubscribe) unsubscribe(); win = null; }, 30, { icon: 'settings' });
        var body = win.getBody();
        body.innerHTML =
            '<div class="st">' +
              '<nav class="st-tabs" role="tablist">' +
                ['account', 'sessions', 'connection'].map(function (t) { return '<button class="btn btn--ghost" role="tab" data-tab="' + t + '" type="button">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'; }).join('') +
              '</nav>' +
              '<section class="st-pane" id="st-pane"></section>' +
            '</div>';
        var style = document.createElement('style');
        style.textContent = '.st{display:flex;flex-direction:column;height:100%}.st-tabs{display:flex;gap:6px;padding:8px;background:var(--bg-terciary);border-bottom:3px double var(--border-terciary)}' +
            '.st-pane{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px}.st-card{padding:12px 14px;border-radius:14px;background:var(--surface);border:2px solid var(--border-quaduary);display:flex;align-items:center;gap:12px}' +
            '.st-card .grow{min-width:0}.st-card small{color:var(--ink-soft);display:block}.st-form{display:flex;flex-direction:column;gap:10px;max-width:340px}.st h4{font-family:var(--font-pixel);font-size:18px}';
        body.appendChild(style);
        var pane = body.querySelector('#st-pane');

        function show(tab) {
            body.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
            ({ account: account, sessions: sessions, connection: connection })[tab]();
        }
        win._show = show;
        body.querySelector('.st-tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });

        function account() {
            var u = auth.getUser() || {};
            pane.innerHTML = '<h4>Account</h4><div class="st-card">' + icon('user', 'icon--lg') + '<div class="grow"><b>' + esc(u.username) + '</b><small>Signed in</small></div></div>' +
                '<h4>Change password</h4><form class="st-form" id="pw" novalidate>' +
                '<div class="ui-field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>' +
                '<div class="ui-field"><label>New password (8+ characters)</label><input class="input" type="password" name="next" autocomplete="new-password"></div>' +
                '<div class="ui-field"><label>Repeat new password</label><input class="input" type="password" name="again" autocomplete="new-password"></div>' +
                '<div class="ui-error" id="pw-error" role="alert"></div><button class="btn btn--primary" type="submit">Change password</button>' +
                '<small class="muted">Your other devices are signed out when the password changes.</small></form>';
            pane.querySelector('#pw').addEventListener('submit', function (e) {
                e.preventDefault();
                var f = e.target, err = pane.querySelector('#pw-error');
                err.textContent = '';
                if (f.next.value !== f.again.value) { err.textContent = 'The new passwords do not match.'; return; }
                auth.request('/auth/password', { method: 'POST', json: { current: f.current.value, next: f.next.value } }).then(function (r) {
                    f.reset();
                    __ui.toast('Password changed' + (r.revoked ? ' - ' + r.revoked + ' other session(s) signed out' : ''), 'ok');
                }).catch(function (x) {
                    err.textContent = x.code === 'wrong_password' ? 'The current password is wrong.' : x.code === 'validation_error' ? 'The new password is too short.' : __ui.errorText(x);
                });
            });
        }

        function sessions() {
            pane.innerHTML = '<h4>Where you are signed in</h4><div id="st-list">Loading…</div><div><button class="btn" id="st-others" type="button">Sign out all other devices</button></div>';
            var list = pane.querySelector('#st-list');
            function load() {
                auth.request('/auth/sessions').then(function (r) {
                    list.innerHTML = r.sessions.map(function (s) {
                        return '<div class="st-card">' + icon('wifi', 'icon--lg') + '<div class="grow"><b>' + esc(describeAgent(s.userAgent)) + (s.current ? ' <span class="badge">this device</span>' : '') + '</b>' +
                            '<small>' + esc(s.ip || 'unknown address') + ' · last active ' + ago(s.lastUsedAt) + ' · signed in ' + ago(s.createdAt) + '</small></div>' +
                            (s.current ? '' : '<button class="btn btn--sm btn--danger" data-revoke="' + esc(s.id) + '" type="button">Sign out</button>') + '</div>';
                    }).join('') || 'No sessions.';
                    pane.querySelector('#st-others').disabled = r.sessions.length < 2;
                }).catch(function (e) { list.textContent = __ui.errorText(e); });
            }
            list.addEventListener('click', function (e) {
                var b = e.target.closest('[data-revoke]');
                if (b) auth.request('/auth/sessions/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' }).then(load, function (x) { __ui.toast(__ui.errorText(x), 'error'); });
            });
            pane.querySelector('#st-others').addEventListener('click', function () {
                auth.request('/auth/sessions', { method: 'DELETE' }).then(function (r) { __ui.toast(r.revoked + ' session(s) signed out', 'ok'); load(); });
            });
            load();
        }

        function connection() {
            var ws = document.wsscon;
            pane.innerHTML = '<h4>Apps gateway</h4><div class="st-card" id="st-conn"></div><small class="muted">The desktop talks to the server over one websocket. It re-authenticates itself each time the access token is renewed and reconnects automatically.</small>';
            var card = pane.querySelector('#st-conn');
            unsubscribe = ws.onStatus(function (s) {
                card.innerHTML = icon('wifi', 'icon--lg') + '<div class="grow"><b>' + esc(s.state) + '</b><small>' + (s.latency != null ? 'latency ' + s.latency + ' ms' : 'latency unknown') + (s.attempts ? ' · reconnect attempt ' + s.attempts : '') + '</small></div>';
            });
        }

        show(tab || 'account');
    };
})();
