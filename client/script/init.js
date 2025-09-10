if (!document.renderer)
    document.renderer = __renderer.build();

if (!document.app)
    document.app = undefined;

if (!document.loaded)
    document.loaded = false;

if (!document.userInstanceCache)
    document.userInstanceCache = {};

if (!document.wsscon)
    document.wsscon = null;

(() => {
    var main = () => {

        if (!document.location.pathname.endsWith('/')) {
            document.location.replace(document.location.pathname + '/');
            return;
        }
        if (document.location.pathname == "/connect/" && window.localStorage.getItem("host") && window.localStorage.getItem("token")) {
            document.location.replace('/desktop/')
            return;
        }
        if (document.location.pathname != "/connect/" && (!window.localStorage.getItem("host") || !window.localStorage.getItem("token"))) {
            document.location.replace('/connect/')
            return;
        }

        document.title = "Loading...";
        document.head.innerHTML += `
            <style>* {left: 0;right: 0;top: 0;bottom: 0;padding: 0;margin: 0;box-sizing: border-box;-moz-box-sizing: border-box;-webkit-box-sizing: border-box;}.loader {--c:#fff;width: fit-content;font-weight: bold;font-family: monospace;font-size: 30px;color: #0000;overflow: hidden;text-shadow: 0 0 var(--c),11ch 0 var(--c);animation: l6 2s infinite linear;}.loader:before {content:"Loading...";}@keyframes l6 {to{text-shadow:-11ch 0 var(--c),0ch 0 var(--c)}}</style>
        `;
        document.body.style = `width: 100vw; height: 100vh; overflow: hidden; background-color: black; position: relative;`;
        document.body.innerHTML = `
            <div id="app" style="flex-direction: column; font-family: 'Inter'; color: white; overflow: hidden; width: 100%; height: 100%; display: flex; position: relative; justify-content:center; align-items: center;"><div class="loader"></div></div>
            <div id="loaderIndicator" style="pointer-events: none; font-family: 'Inter'; font-size: 10px; color: white; position: absolute; left: 1px; top: calc(100% - 11px);">preparing instance</div>
            <div id="errorIndicator" style="display: none; align-items: center; flex-direction: column; justify-content:space-evenly; font-family: 'Inter'; background-color: gainsboro; border: solid 1px grey; font-size: 12px; color: black; position: absolute; left: calc(50% - 40%); top: calc(50% - 10%); width: 80%; height: 20%;"><h5>failed to load app</h5><p id="errorIndicatorMessage" style="font-size: 8px;">test</p><button style="font-size: 10px;" onclick="document.location.reload()">Reload app</button></div>
        `;

        var appCanva = document.getElementById("app");
        var errorIndicator = document.getElementById("errorIndicator");
        var errorIndicatorMessage = document.getElementById("errorIndicatorMessage");
        var loaderIndicator = document.getElementById("loaderIndicator");

        document.app = __appHandler.getInstance("index.json");

        renderer = document.renderer;
        app = document.app;

        if (!errorIndicator || !errorIndicatorMessage) {
            document.body.innerHTML = '<div style="width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center;"><h1 style="text-align: center; color: red;">client error: fatal unrecoverable state of the engine, page not builded properly, missing necessary HUD elements</h1></div>';
            return;
        }

        renderer.registerErrorDisplay(errorIndicator, errorIndicatorMessage);
        renderer.registerLoadDisplay(loaderIndicator);

        if (!loaderIndicator) {
            renderer.showError("client error: could not find engine loader HUD.")
            return;
        }

        app.onReady(() => {
            app.setTitle("App")
            renderer.hideLoad();
            renderer.hideError();

            if (!appCanva) {
                renderer.showError("client error: could not find engine render canva.")
                return;
            }

            appCanva.innerHTML = '';

            if (document.location.pathname == "/connect/" || document.location.pathname == "/maintenance/") {
                console.log("app is ready.");

                if (document.onloaded)
                    document.onloaded();
                document.loaded = true;
                return;
            }

            app.getLibrary().request("http://" + localStorage.getItem("host") + '/verify', null, "POST", {"Content-Type": "application/json"}).then((data) => {
                try {
                    if (JSON.parse(data.request.responseText).message != "token_ok") {
                        localStorage.removeItem("token");
                        document.location.replace("/connect/");
                        return;
                    }
                } catch {
                    localStorage.removeItem("token");
                    document.location.replace("/connect/");
                    return;
                }
                app.getLibrary().request("http://" + localStorage.getItem("host") + '/wsockets', null, "GET", {"Content-Type": "application/json"}).then((data) => {
                    try {
                        let server = JSON.parse(data.request.responseText).wssockets[0];

                        if (!server) {
                            console.log("no server");
                            document.location.replace("/maintenance/");
                            return;
                        }

                        document.wsscon = __ws.new("ws://" + server["host"]);

                        wsscon = document.wsscon;

                        wsscon.setReconnect((ws) => {
                            ws.data.send(JSON.stringify({action: "connect", data: {token: localStorage.getItem("token")}}));
                            console.log("reconnected");
                        });
                        wsscon.setRoute("connect", (ws, msg) => {
                            if (msg["data"]["message"] == "ok" && msg["code"] == 0) {
                                console.log("connected to socket.");
                                wsscon.setReady(true);
                                return;
                            }
                            localStorage.removeItem("token");
                            document.location.replace("/connect/");
                            return;
                        });

                        wsscon.open().then((ws) => {
                            ws.data.send(JSON.stringify({action: "connect", data: {token: localStorage.getItem("token")}}));

                            console.log("app is ready.");

                            try {
                                if (document.onloaded)
                                    document.onloaded();
                            } catch(err) {
                                console.log(err);
                                return
                            }
                            document.loaded = true;
                            return;
                        }).catch((err) => {
                            console.log(err);
                            document.location.replace("/maintenance/");
                            return;
                        });
                    } catch (e) {
                        console.log(e);
                        document.location.replace("/maintenance/");
                        return;
                    }
                }).catch(err => {
                    console.log(err);
                    document.location.replace("/maintenance/");
                    return;
                });
            }).catch(err => {
                if (err.request) {
                    localStorage.removeItem("token");
                    document.location.replace("/connect/");
                    return;
                }
                document.location.replace("/maintenance/");
                return;
            });
        }, (data) => {
            if (data)
                renderer.showLoad(`loaded ${data.type} ${data.loaded}`);
        }, (error) => {
            app.setTitle("Error")
            renderer.hideLoad();
            renderer.showError(error.message);
        });
    };

    if (document.readyState === "complete")
        return main();

    document.addEventListener("DOMContentLoaded", main);
})();

