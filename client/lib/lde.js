var __window = (() => {
    var maxZ = 15;

    function init(title, size = [800, 600], parent = null, onclose = null, marginMinimizePos = 30) {
        var win = document.createElement("div");
        var body;
        var header;
        var marginMinimizePos = marginMinimizePos;

        var flags = 0x00;

        var x;
        var y;

        var onclose = onclose

        var oldX;
        var oldY;

        function eventMove(event) {
            if ((flags & (1 << 0))) {
                flags &= ~(1 << 0);
                win.style.width = `${size[0]}px`;
                win.style.height = `${size[1]}px`;
            }
            event = event ? event : window.event;
            event.preventDefault();

            win.style.top = (win.offsetTop - (y - event.clientY)) + "px";
            win.style.left = (win.offsetLeft - (x - event.clientX)) + "px";

            x = event.clientX;
            y = event.clientY;
        }

        function eventClick(event) {
            event = event ? event : win.event;
            event.preventDefault();

            x = event.clientX;
            y = event.clientY;
            document.onmouseup = () => {
                document.onmouseup = null;
                document.onmousemove = null;

                if (win.offsetTop < 0)
                    win.style.top = "0px";
                if (win.offsetLeft + size[0] - 100 < 0)
                    win.style.left = `${-size[0] + 100}px`;
            };

            document.onmousemove = eventMove;
        }

        maxZ += 1;

        win.classList.add("window");
        win.style = `position: absolute; min-width: 100px; width: ${size[0]}px; min-height: 100px; height: ${size[1]}px;`;
        win.innerHTML = `
            <div class="win-header" style="width: 100%; display: flex; flex-direction: row; justify-content: space-between; align-items: center;">
                <p style="margin-left: 5px;">${title ? title : "window"}</p><div class="win-buttons"><button class="win-button-minimize">&#128469;</button><button class="win-button-maximize">🗖</button><button class="win-button-close">&#10006;</button></div>
            </div>
            <div class="win-body" style="width: 100%; height: calc(100% - 25px); overflow-y: auto;">
            </div>
        `

        if (parent)
            win = parent.appendChild(win);
        else
            win = document.body.appendChild(win);

        win.style.zIndex = `${maxZ}`;

        body = win.querySelector(".win-body");
        header = win.querySelector(".win-header");

        header.querySelector(".win-button-close").addEventListener("click", (event) => {
            if (!(flags & (1 << 1))) {
                flags |= (1 << 1);
                win.style.display = "none";
                if (onclose)
                    onclose();
                win.remove();
            } else {
                flags &= ~(1 << 1);
                win.style.display = "block";
            }
        });
        // header.querySelector(".win-button-down").addEventListener("click", (event) => {
        //     if (!(flags & (1 << 0))) {
        //         flags |= (1 << 0);
        //         body.style.display = "none";
        //     } else {
        //         flags &= ~(1 << 0);
        //         body.style.display = "block";
        //     }
        // });
        header.querySelector(".win-button-maximize").addEventListener("click", (event) => {
            if (!(flags & (1 << 0))) {
                flags |= (1 << 0);
                if ((flags & (1 << 2))) {
                    flags &= ~(1 << 2);
                    header.addEventListener("mousedown", eventClick, true);
                }
                win.style.width = "100%";
                win.style.height = "100%";
                win.style.top = "0";
                win.style.left = "0";
            } else {
                flags &= ~(1 << 0);
                win.style.width = `${size[0]}px`;
                win.style.height = `${size[1]}px`;
            }
        });
        header.querySelector(".win-button-minimize").addEventListener("click", (event) => {
            if (!(flags & (1 << 2))) {
                if ((flags & (1 << 0))) {
                    win.style.width = `${size[0]}px`;
                    win.style.height = `${size[1]}px`;
                }
                flags |= (1 << 2);
                oldX = win.getBoundingClientRect().left;
                oldY = win.getBoundingClientRect().top;
                win.style.top = `${window.innerHeight - header.clientHeight - marginMinimizePos}px`;
                header.removeEventListener("mousedown", eventClick, true);
            } else {
                if ((flags & (1 << 0))) {
                    win.style.width = `100%`;
                    win.style.height = `100%`;
                    win.style.top = "0";
                    win.style.left = "0";
                }
                flags &= ~(1 << 2);
                win.style.top = `${oldY}px`;
                win.style.left = `${oldX}px`;
                header.addEventListener("mousedown", eventClick, true);
            }
        });

        header.addEventListener("mousedown", eventClick, true);
        win.addEventListener("mousedown", (event) => {
            if (`${maxZ}` !== win.style.zIndex) {
                maxZ += 1;

                win.style.zIndex = `${maxZ}`;
            }
        });

        return ({
            editContent: function (dom) {
                body.appendChild(dom);
            },
            setIframe: function (url) {
                body.innerHTML = `
                <iframe src="${url}" style="width: 100%; height: 100%"></iframe>
                `;
            },
            getBody: function () {
                return (body);
            }
        });
    }

    return ({
        new: init
    });
})();
