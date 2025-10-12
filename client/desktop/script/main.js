if (!document.__desktopScript) {
document.__desktopScript = (() => {
    function init() {
        var desktopHandler = __desktop.new();

        var windows = {};
        var lastId = 0;

        var parentWindow = null;
        var startMenuDom = null;
        var startMenuButton = null;
        
        var startMenuState = false;

        function createWindow(title, sizes, onclose) {
            let actualId = lastId;
            windows[actualId] = __window.new(title, sizes, parentWindow, () => {delete windows[actualId]; if (onclose) onclose(); console.log(windows);});
            ++lastId;

            return (actualId);
        }

        function getWinBody(id) {
            if (!windows[id])
                return (null);
            return (windows[id].getBody());
        }

        function loadUIWin(ui, id) {
            var body = getWinBody(id);

            document.app.build(ui, body);
            return (body);
        }

        function openMusicApp() {
            var audioPlayer = null;
            var sessionIdG = -1;

            var win = createWindow("music player", [400, 625], () => {
                console.log(audioPlayer, sessionIdG);
                if (audioPlayer)
                    audioPlayer.nonStandaloneDestroy();
                document.wsscon.closeApp(sessionIdG);
            });
            var body = getWinBody(win);

            audioPlayer = document.setupApp.musicPlayer(body, false, {
                "main": "/apps/musicPlayer/UI/main.html",
                "menu": "/apps/musicPlayer/UI/menu.html",
                "playlist": "/apps/musicPlayer/UI/playlist.html",
                "song": "/apps/musicPlayer/UI/song.html"
            }, (sessionId) => {sessionIdG = sessionId});

            body.children[0].children[0].style.borderRadius = "0";
        }

        function openExplorerApp() {
            var explorer = null;
            var sessionIdG = -1;

            var win = createWindow("explorer", [800, 600], () => {
                console.log(explorer, sessionIdG);
                if (explorer)
                    explorer.nonStandaloneDestroy();
                document.wsscon.closeApp(sessionIdG);
            });
            var body = getWinBody(win);

            explorer = document.setupApp.explorer(body, false, {
                "main": "/apps/explorer/UI/main.html",
                "item": "/apps/explorer/UI/item.html"
            }, (sessionId) => {sessionIdG = sessionId});

            body.children[0].children[0].style.borderRadius = "0";

            //body.children[0].children[0].classList.remove("shadow-light");
        }

        function setDrawWindowDom(dom) {
            if (!dom)
                return;
            parentWindow = dom;
        }

        function setSelectionCanva(dom, parent) {
            if (!dom)
                return;
            if (!parent)
                return;
            desktopHandler.setSelectionRect(dom, parent);
        }

        function setStartMenu(startMenu, button) {
            if (!startMenu)
                return;
            if (!button)
                return;

            startMenuDom = startMenu;
            startMenuButton = button;

            startMenuDom.style.display = "none";
            startMenuState = false;

            startMenuButton.addEventListener("click", () => {
                if (startMenuState === false) {
                    startMenuDom.style.display = "block";
                    startMenuState = true;
                } else {
                    startMenuDom.style.display = "none";
                    startMenuState = false;
                }
            });
        }

        return ({
            createWindow: createWindow,
            getWinBody: getWinBody,
            openMusicApp: openMusicApp,
            openExplorerApp: openExplorerApp,
            setDrawWindowDom: setDrawWindowDom,
            setSelectionCanva: setSelectionCanva,
            setStartMenu: setStartMenu
        });
    }

    return ({
        new: function () {
            return (init());
        }
    });
})();
}
