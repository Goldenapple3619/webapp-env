if (!document.setupApp)
    document.setupApp = {};

if (!document.setupApp.musicPlayer) {
    document.setupApp.musicPlayer = ((parent = document.body, standalone = false, UIs = {
        "main": "UI/main.html",
        "menu": "UI/menu.html",
        "playlist": "UI/playlist.html",
        "song": "UI/song.html"
    }, onConnect = (sessionId) => {console.log(`music app connected ${sessionId}.`)}) => {
        var audioPlayer = document.__audioPlayerScript.new();
        var playlists = null;
        var selected = undefined;
        var mode = "player";

        document.app.build(UIs["main"], parent);

        if (standalone)
            document.app.setTitle("Music Player");

        document.wsscon.onReady(() => {
            document.wsscon.connectApp("music", {
                "fetch_app": (ws, msg) => {
                    if (msg.data.message !== "fetch_done") {
                        console.error(msg);
                        return;
                    }
                    if (msg.data["value"]["type"] == "playlists") {
                        var found = null;
                        playlists = msg.data["value"]["content"];

                        if (mode === "player" && selected === undefined) {
                            selected = playlists[0].name;
                        }

                        playlists.forEach((x) => {
                            x.songs.forEach((y) => {
                                y.endpoint = 'http://' + localStorage.getItem('host') + '/my' + y.endpoint;
                                y.cover = 'http://' + localStorage.getItem('host') + '/my' + y.cover;
                            });
                            if (found !== null)
                                return;
                            if (x.name !== selected)
                                return;
                            found = x;
                        });

                        if (!found)
                            return;

                        audioPlayer.getAudioList().splice(0, audioPlayer.getAudioList().length);

                        found["songs"].forEach(x => {
                            audioPlayer.getAudioList().push(x);
                        });

                        audioPlayer.autoSelect();
                    }
                }
            }, (sessionId) => {
                onConnect(sessionId);

                document.wsscon.send(JSON.stringify({action: "fetch_app", data: {app_session: sessionId, fetch_type: "playlists"}}));
            }, (sessionId) => {
                onConnect(sessionId);
            }, (data) => {
                console.log(`music app error ${data}.`);
            }, (data) => {
                console.log(`music app error restore ${data}.`);
            });
        });

        function resetButtons() {
            var playButton = parent.querySelector(".play-button");
            var loopButton = parent.querySelector(".button-loop");
            var randomButton = parent.querySelector(".button-random");

            audioPlayer.setRender(parent.querySelector(".name-song"), parent.querySelector(".cover-song"));

            audioPlayer.setToggle(playButton, function () {
                playButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a599cc" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause-icon lucide-pause"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>`;
            }, function () {
                playButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a599cc" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
            });
            audioPlayer.setScroller(parent.querySelector(".scroller-button"), parent.querySelector(".scroller-bar"));
            audioPlayer.setTimeDisplay(parent.querySelector(".actual-time-display"), parent.querySelector(".max-time-display"))
            audioPlayer.setToggleLoop(loopButton, function () {
                loopButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat-icon lucide-repeat"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`;
            }, function () {
                loopButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a599cc" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat-icon lucide-repeat"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`;
            }, function () {
                loopButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a599cc" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat1-icon lucide-repeat-1"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>`;
            });
            audioPlayer.setToggleRandom(randomButton, function () {
                randomButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shuffle-icon lucide-shuffle"><path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/></svg>`;
            }, function () {
                randomButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a599cc" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shuffle-icon lucide-shuffle"><path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/></svg>`;
            });
            audioPlayer.setSoundControl(parent.querySelector(".volume-button"), parent.querySelector(".volume-bar"))
            audioPlayer.setSkipNext(parent.querySelector(".next-song-button"));
            audioPlayer.setSkipPrev(parent.querySelector(".back-song-button"));
            audioPlayer.setIndicatorVolume(parent.querySelector(".indicator-volume-display")),
            parent.querySelector(".menu-button").addEventListener("click", () => {
                let plstContainer;

                mode = "list";

                audioPlayer.deselectAudio();

                document.app.build(UIs["menu"], parent, {}, {}, {}, true);

                if (standalone)
                    document.app.setTitle("Music Player - Menu");
                else
                    parent.children[0].children[0].style.borderRadius = "0";

                plstContainer = parent.querySelector(".playlist-container");
                if (!plstContainer)
                    return;
                plstContainer.innerHTML = '';
                playlists.forEach((x) => {
                    var playlistUI = document.app.build(UIs["playlist"], plstContainer, {"${PLAYLIST_NAME}": x.name}, {}, {}, false);

                    if (!playlistUI)
                        return;

                    playlistUI.children[0].addEventListener("click", () => {
                        document.app.build(UIs["main"], parent, {}, {}, {}, true);

                        if (standalone)
                            document.app.setTitle("Music Player");
                        else
                            parent.children[0].children[0].style.borderRadius = "0";

                        mode = "player";
                        selected = x.name;

                        resetButtons();

                        audioPlayer.getAudioList().splice(0, audioPlayer.getAudioList().length);

                        x["songs"].forEach(y => {
                            audioPlayer.getAudioList().push(y);
                        });

                        audioPlayer.autoSelect();
                    });

                    songList = playlistUI.querySelector(".song-list");

                    if (!songList)
                        return;

                    x.songs.forEach((x) => {
                        document.app.build(UIs["song"], songList, {"${SONG_NAME}": x.name}, {}, {}, false);
                    });
                });
            });
        }
        resetButtons();

        return (audioPlayer);
    });
}
