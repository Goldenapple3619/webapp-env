(function () {
    var auth = __auth.getInstance();
    var REASONS = {
        expired: 'Your session expired. Please sign in again.',
        logout: 'You have been signed out.',
        other_tab: 'You signed out in another tab.',
        revoked: 'This session was ended from another device.'
    };

    document.onloaded = function () {
        var root = document.getElementById('app');
        document.app.build('/connect/UI/main.html', root);
        document.title = 'Sign in';

        var $ = function (id) { return document.getElementById(id); };
        var form = $('cx-form'), error = $('cx-error'), submit = $('cx-submit'), toggle = $('cx-toggle'), host = $('cx-host');
        var registering = false;

        host.value = localStorage.getItem('host') || '';
        if (host.value) form.querySelector('details').open = true;

        var reason = new URLSearchParams(location.search).get('reason');
        if (reason && REASONS[reason]) { var n = $('cx-notice'); n.textContent = REASONS[reason]; n.hidden = false; }

        auth.getConfig().then(function (cfg) { toggle.hidden = !cfg.registration; });

        function setMode(reg) {
            registering = reg;
            $('cx-confirm-field').hidden = !reg;
            $('cx-subtitle').textContent = reg ? 'Create your account' : 'Sign in to your desktop';
            submit.textContent = reg ? 'Create account' : 'Sign in';
            toggle.textContent = reg ? 'I already have an account' : 'Create an account';
            $('cx-pass').autocomplete = reg ? 'new-password' : 'current-password';
            error.textContent = '';
        }
        toggle.addEventListener('click', function () { setMode(!registering); });

        function setBusy(busy) { submit.disabled = busy; toggle.disabled = busy; }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            error.textContent = '';
            var u = $('cx-user').value.trim(), p = $('cx-pass').value;
            if (!u || !p) { error.textContent = 'Enter a username and a password.'; return; }
            if (registering && p !== $('cx-pass2').value) { error.textContent = 'The passwords do not match.'; return; }

            var h = host.value.trim();
            if (h) localStorage.setItem('host', h); else localStorage.removeItem('host');

            setBusy(true);
            (registering ? auth.register(u, p) : auth.login(u, p)).then(function () {
                var next = document.safeNext(new URLSearchParams(location.search).get('next'));
                location.replace(next || '/desktop/');
            }).catch(function (err) {
                setBusy(false);
                error.textContent = err.network ? 'Cannot reach the server.'
                    : err.code === 'session_ko' ? 'Wrong username or password.'
                    : err.code === 'username_taken' ? 'That username is taken.'
                    : err.code === 'validation_error' && err.data && err.data.errors && err.data.errors[0] ? err.data.errors[0].path + ': ' + err.data.errors[0].message
                    : err.code === 'registration_disabled' ? 'Registration is disabled on this server.'
                    : __ui.errorText(err);
                $('cx-pass').select();
            });
        });
    };
})();
