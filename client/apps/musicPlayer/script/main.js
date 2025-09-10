if (!document.__audioPlayerScript) {
document.__audioPlayerScript = (() => {
    function init() {
        var player = {};
        var audioList = [];
        var selected = undefined;
        var audio = undefined;

        var coverDom;
        var nameDom;

        var callbackPlay;
        var callbackPause;
        var callbackNoLoop;
        var callbackLoop;
        var callbackLoopSong;
        var callbackRandom;
        var callbackNoRandom;

        var controlToggle;
        var controlNext;
        var controlPrevious;
        var controlLoop;
        var controlRandom;
        var controlScrollerBar;
        var controlScroller;
        var controlActualTime;
        var controlMaxTime
        var controlSoundBar;
        var controlSound;
        var controlVolumeIndicator;

        player.status = false;
        player.loop = false;
        player.loop_song = false;
        player.random = false;
        player.duration = 0;
        player.actual = 0;
        player.volume = 1;

        var eventLoadedAudio = (() => {
            var temp = audioList.find(el => el["id"] === selected);
            player.duration = audio.duration;

            if (nameDom)
                nameDom.innerText = temp.name;
            if (coverDom)
                coverDom.src = temp.cover;
            if (controlMaxTime)
                controlMaxTime.innerText = _formatTime(player.duration);
            audio.volume = player.volume;
        });

        var eventUpdateAudio = ((event) => {
            player.actual = audio.currentTime;

            if (controlScroller && controlScrollerBar)
                controlScroller.style.left = `${Math.fround((player.actual * (controlScrollerBar.offsetWidth - controlScroller.offsetWidth)) / player.duration)}px`;
            if (controlActualTime)
                controlActualTime.innerText = _formatTime(player.actual);
        });

        var eventUpdateVolume = ((event) => {
            player.volume = audio.volume;

            if (controlVolumeIndicator) {
                if (player.volume >= 0.60) {
                    if (controlVolumeIndicator.children[0].getAttribute("attr-type") !== "75") {
                        controlVolumeIndicator.innerHTML = `<svg attr-type="75" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume2-icon lucide-volume-2"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></svg>`;
                    }
                } else if (player.volume >= 0.30) {
                    if (controlVolumeIndicator.children[0].getAttribute("attr-type") !== "50")
                        controlVolumeIndicator.innerHTML = `<svg attr-type="50" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume1-icon lucide-volume-1"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/></svg>`;
                } else if (player.volume >= 0.05) {
                    if (controlVolumeIndicator.children[0].getAttribute("attr-type") !== "25")
                    controlVolumeIndicator.innerHTML = `<svg attr-type="25" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-icon lucide-volume"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/></svg>`;
                } else if (controlVolumeIndicator.children[0].getAttribute("attr-type") !== "0") {
                    controlVolumeIndicator.innerHTML = `<svg attr-type="0" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E3EAF1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-x-icon lucide-volume-x"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>`;
                }
            }

            if (controlSound && controlSoundBar)
                controlSound.style.top = `calc(100% - ${Math.fround((player.volume * (controlSoundBar.offsetHeight - controlScroller.offsetHeight)) / 1)}px)`;
        });

        var eventEndAudio = (() => {
            pause();
            if (player.loop_song == true) {
                player.actual = 0;
                if (controlActualTime)
                    controlActualTime.innerText = _formatTime(player.actual);
                audio.currentTime = player.actual;
                play();
            } else {
                if ((audioList.findIndex(el => el["id"] === selected) + 1) >= audioList.length && !player.loop)
                    return;
                audioNext();
            }
        });

        function _formatTime(time) {
            var minutes = Math.floor((time) / 60);
            var seconds = time - (minutes * 60);

            return (`${Math.round(minutes)}:${Math.round(seconds).toString().padStart(2, '0')}`);
        }

        function deselectAudio() {
            if (nameDom)
                nameDom.innerText = "...";
            if (coverDom)
                coverDom.src = "";

            selected = undefined;

            if (controlScroller)
                controlScroller.style.left = 0;
            if (controlMaxTime)
                controlMaxTime.innerText = "0:00";
            if (controlActualTime)
                controlActualTime.innerText = "0:00";

            if (audio) {
                pause();
                audio.removeEventListener("loadeddata", eventLoadedAudio);
                audio.removeEventListener("timeupdate", eventUpdateAudio);
                audio.removeEventListener("volumechange", eventUpdateVolume);
                audio.removeEventListener('ended', eventEndAudio);
                delete audio;
            }

            audio = undefined;
        }

        function autoSelect() {
            if (!audioList)
                return;
            selectAudio(selected !== undefined ? selected : audioList[0].id, false);
        }

        function selectAudio(id, doPlay) {
            var temp = audioList.find(el => el["id"] === id);

            deselectAudio();

            selected = id;
            audio = new Audio(temp.endpoint);

            if (audio.readyState == 4) {
                eventLoadedAudio();
            } else {
                audio.addEventListener("loadeddata", eventLoadedAudio);
            }

            audio.addEventListener("timeupdate", eventUpdateAudio);
            audio.addEventListener("volumechange", eventUpdateVolume);
            audio.addEventListener('ended', eventEndAudio);
            audio.addEventListener('pause', callbackPause);
            audio.addEventListener('play', callbackPlay);

            if (doPlay === undefined || doPlay) {
                play();
            }
        }

        function audioNext() {
            if (player.random) {
                selected = audioList[Math.floor(Math.random() * (audioList.length))].id;
                selectAudio(selected);
                return;
            }
            if (selected === undefined)
                selected = audioList[0].id;
            else
                selected = audioList[(audioList.findIndex(el => el["id"] === selected) + 1) % audioList.length].id;

            selectAudio(selected);
        }

        function audioPrevious() {
            var temp = null;

            if (player.random) {
                selected = audioList[Math.floor(Math.random() * (audioList.length))].id;
                selectAudio(selected);
                return;
            }

            if (selected === undefined)
                selected = audioList[0].id;
            else {
                temp = (audioList.findIndex(el => el["id"] === selected) - 1);
                if (temp < 0)
                    selected = audioList[audioList.length - 1].id;
                else
                    selected = audioList[temp].id;
            }

            selectAudio(selected);
        }

        function play() {
            if (!audio)
                return;
            player.status = true;
            audio.play();
            if (callbackPlay)
                callbackPlay();
        }

        function pause() {
            if (!audio)
                return;
            player.status = false;
            audio.pause();
            if (callbackPause)
                callbackPause();
        }

        function loop() {
            player.loop = true;
            player.loop_song = false;

            if (callbackLoop)
                callbackLoop();
        }

        function loopSong() {
            player.loop = false;
            player.loop_song = true;

            if (callbackLoopSong)
                callbackLoopSong();
        }

        function noLoop() {
            player.loop = false;
            player.loop_song = false;

            if (callbackNoLoop)
                callbackNoLoop();
        }

        function toggleLoop() {
            if (player.loop)
                loopSong();
            else if (player.loop_song)
                noLoop();
            else
                loop();
        }

        function random() {
            player.random = true;

            if (callbackRandom)
                callbackRandom();
        }

        function noRandom() {
            player.random = false;

            if (callbackNoRandom)
                callbackNoRandom();
        }

        function toggleRandom() {
            if (player.random)
                noRandom();
            else
                random();
        }

        function toggle() {
            if (!audio)
                return;
            if (player.status)
                pause();
            else
                play();
        }

        function setEventToggle(dom, cbplay, cbpause) {
            if (!dom)
                return;
            callbackPlay = cbplay;
            callbackPause = cbpause;
            controlToggle = dom;
            if (dom) {
                dom.addEventListener("click", (ev) => {
                    toggle();
                });
            }
        }

        function setEventLoop(dom, cbnoloop, cbloop, cbloopsong) {
            if (!dom)
                return;
            callbackNoLoop = cbnoloop;
            callbackLoop = cbloop;
            callbackLoopSong = cbloopsong;
            controlLoop = dom;
            if (dom) {
                dom.addEventListener("click", (ev) => {
                    toggleLoop()
                });
            }
        }

        function setEventRandom(dom, cbnorandom, cbrandom) {
            if (!dom)
                return;
            callbackNoRandom = cbnorandom;
            callbackRandom = cbrandom;
            controlRandom = dom;
            if (dom) {
                dom.addEventListener("click", (ev) => {
                    toggleRandom()
                });
            }
        }

        function setSkipNext(dom) {
            if (!dom)
                return;
            controlNext = dom;
            if (dom) {
                dom.addEventListener("click", (ev) => {
                    audioNext();
                });
            }
        }

        function setSkipPrev(dom) {
            if (!dom)
                return;
            controlPrevious = dom;
            if (dom) {
                dom.addEventListener("click", (ev) => {
                    audioPrevious();
                });
            }
        }

        function setSoundControl(dom, domBar) {
            var clicked = false;
            var evMove = ((ev) => {
                if (!audio)
                    return;
                if (!controlSound || !controlSoundBar)
                    return;
                delta = controlSoundBar.getBoundingClientRect().bottom - ev.clientY;

                if (delta < 0)
                    delta = 0;
                if ((delta * 1) / (controlSoundBar.offsetHeight) > 1)
                    delta = controlSoundBar.offsetHeight;

                player.volume = (delta * 1) / controlSoundBar.offsetHeight;
                audio.volume = player.volume;

                ev.preventDefault();
            });

            var evUp = ((ev) => {
                if (ev.button != 0 || !clicked)
                    return;
                clicked = false;

                document.removeEventListener("mousemove", evMove);
                document.removeEventListener("mouseup", evUp);

                ev.preventDefault();
                ev.stopPropagation();
            })

            controlSound = dom;
            controlSoundBar = domBar;

            if (controlSound) {
                controlSound.addEventListener("mousedown", (ev) => {
                    if (ev.button != 0)
                        return;
                    clicked = true;

                    document.addEventListener("mousemove", evMove);
                    document.addEventListener("mouseup", evUp);

                    ev.preventDefault();
                    ev.stopPropagation();
                });
            }


            if (controlSoundBar) {
                controlSoundBar.addEventListener("mousedown", (ev) => {
                    if (ev.button != 0)
                        return;
                    clicked = true;

                    evMove(ev);

                    document.addEventListener("mousemove", evMove);
                    document.addEventListener("mouseup", evUp);

                    ev.preventDefault();
                    ev.stopPropagation();
                });
            }
        }

        function setScroller(dom, domBar) {
            var clicked = false;
            var evMove = ((ev) => {
                if (!audio)
                    return;
                if (!controlScroller || !controlScrollerBar)
                    return;
                delta = ev.clientX - controlScrollerBar.getBoundingClientRect().left;

                if (delta < 0)
                    delta = 0;
                if ((delta * player.duration) / (controlScrollerBar.offsetWidth) > player.duration)
                    delta = controlScrollerBar.offsetWidth;

                player.actual = (delta * player.duration) / controlScrollerBar.offsetWidth;
                audio.currentTime = player.actual;

                if (controlActualTime)
                    controlActualTime.innerText = _formatTime(player.actual);

                ev.preventDefault();
            });

            var evUp = ((ev) => {
                if (ev.button != 0 || !clicked)
                    return;
                clicked = false;

                document.removeEventListener("mousemove", evMove);
                document.removeEventListener("mouseup", evUp);

                ev.preventDefault();
                ev.stopPropagation();
            })

            controlScroller = dom;
            controlScrollerBar = domBar;

            if (controlScroller) {
                controlScroller.addEventListener("mousedown", (ev) => {
                    if (ev.button != 0)
                        return;
                    clicked = true;

                    document.addEventListener("mousemove", evMove);
                    document.addEventListener("mouseup", evUp);

                    ev.preventDefault();
                    ev.stopPropagation();
                });
            }


            if (controlScrollerBar) {
                controlScrollerBar.addEventListener("mousedown", (ev) => {
                    if (ev.button != 0)
                        return;
                    clicked = true;

                    evMove(ev);

                    document.addEventListener("mousemove", evMove);
                    document.addEventListener("mouseup", evUp);

                    ev.preventDefault();
                    ev.stopPropagation();
                });
            }
        }

        function setTimeDisplay(domActual, domMax) {
            controlActualTime = domActual;
            controlMaxTime = domMax;
        }

        function setIndicatorVolume(dom) {
            controlVolumeIndicator = dom;
        }

        function setRender(name, cover) {
            nameDom = name;
            coverDom = cover;
        }

        function nonStandaloneDestroy() {
            deselectAudio();
        }

        return ({
            selectAudio: selectAudio,
            deselectAudio: deselectAudio,
            audioNext: audioNext,
            audioPrevious: audioPrevious,
            play: play,
            pause: pause,
            toggle: toggle,
            loop: loop,
            loopSong: loopSong,
            noLoop: noLoop,
            toggleLoop: toggleLoop,
            toggleRandom: toggleRandom,
            random: random,
            noRandom: noRandom,

            setRender: setRender,
            setToggle: setEventToggle,
            setScroller: setScroller,
            setTimeDisplay: setTimeDisplay,
            setToggleLoop: setEventLoop,
            setToggleRandom: setEventRandom,
            setSkipNext: setSkipNext,
            setSkipPrev: setSkipPrev,
            setSoundControl: setSoundControl,
            setIndicatorVolume: setIndicatorVolume,

            autoSelect: autoSelect,

            nonStandaloneDestroy: nonStandaloneDestroy,
            getAudioList: function () {
                return (audioList);
            }
        });
    }

    return ({
        new: function () {
            return (init());
        }
    });
})();
}
