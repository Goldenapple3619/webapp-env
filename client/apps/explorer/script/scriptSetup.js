if (!document.setupApp)
    document.setupApp = {};

if (!document.setupApp.explorer) {
    document.setupApp.explorer = ((parent = document.body, standalone = false, UIs = {
        "main": "UI/main.html",
        "item": "UI/item.html"
    }, onConnect = (sessionId) => {console.log(`explorer connected ${sessionId}.`)}) => {
        var actualHash = "";

        document.app.build(UIs["main"], parent);

        if (standalone)
            document.app.setTitle("Explorer");

        var explorer = document.__explorerScript.new();
        var openItem = ((x, sessionId) => {
            if (x.type === "folder") {
                document.wsscon.send(JSON.stringify({action: "fetch_app", data: {app_session: sessionId, fetch_type: "listdir", query: {path: x.path}}}));
                return;
            }
        });
        var setHashChanging = ((sessionId) => {
            window.onhashchange = (ev) => {
                if (window.location.hash != actualHash)
                    document.wsscon.send(JSON.stringify({action: "fetch_app", data: {app_session: sessionId, fetch_type: "listdir", query: {path: window.location.hash.replace('#', '')}}}));

                ev.preventDefault();
            };
        });

        document.wsscon.onReady(() => {
            document.wsscon.connectApp("explorer", {
                "fetch_app": (ws, msg) => {
                    if (msg.data.message !== "fetch_done") {
                        console.error(msg);
                        return;
                    }
                    if (msg.data.value.type === "listdir") {
                        explorer.clearItem();

                        if (standalone) {
                            actualHash = `#${msg.data.value.fetched}/`;
                            window.location.hash = actualHash;
                        }

                        explorer.setPath(`${msg.data.value.fetched}/`);

                        if (msg.data.value.fetched !== "")
                            explorer.addItem("..", `${msg.data.value.fetched}/..`, 0, "folder", null, 0, 0, UIs["item"]);

                        msg.data.value.content.forEach(element => {
                            explorer.addItem(element.name + (element.type === "folder" ? '/' : ''),  element.path, element.size, element.type, element.icon, element.creation_date, element.modification_date, UIs["item"]);
                        });
                    }
                },
                "update_app": (ws, msg) => {
                },
            }, (sessionId) => {
                onConnect(sessionId);

                if (standalone)
                    setHashChanging(sessionId);
                explorer.setCallbackOpen((x) => {openItem(x, sessionId)});

                document.wsscon.send(JSON.stringify({action: "fetch_app", data: {app_session: sessionId, fetch_type: "listdir", query: {path: "/"}}}));
            }, (sessionId) => {
                onConnect(sessionId);

                if (standalone)
                    setHashChanging(sessionId);
                explorer.setCallbackOpen((x) => {openItem(x, sessionId)});
            }, (data) => {
                console.log(`explorer app error ${data}.`);
            }, (data) => {
                console.log(`explorer app error restore ${data}.`);
            });
        });
        explorer.setItemPoolDom(parent.querySelector(".item-pool-explorer"));
        explorer.setPathDom(parent.querySelector(".path-text-explorer"));

        return (explorer);
    });
}
