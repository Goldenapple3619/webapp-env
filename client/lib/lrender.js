var __renderer = (() => {
    function build() {
        var errorDisplay = null;
        var errorTextDisplay = null;
        var loadDisplay = null;

        return ({
            registerErrorDisplay: function (dom, text) {
                errorDisplay = dom;
                errorTextDisplay = text;
            },
            registerLoadDisplay: function (dom) {
                loadDisplay = dom;
            },
            showLoad: function (text) {
                loadDisplay.innerText = text;
            },
            hideLoad: function () {
                loadDisplay.innerText = '';
            },
            showError: function (error) {
                if (errorTextDisplay)
                    errorTextDisplay.innerText = error;
                if (errorDisplay)
                    errorDisplay.style.display = "flex";
            },
            hideError: function () {
                if (errorTextDisplay)
                    errorTextDisplay.innerText = '';
                if (errorDisplay)
                    errorDisplay.style.display = "none";
            }
        });
    };

    return ({
        build: build
    });
})();

var __preLoader = (() => {
    var instance = null;

    function listCallbackAlgorithm(callbacks, each, then, error) {
        let newCallbacks = [];

        for (let index = 0; index < callbacks.length; ++index) {
            newCallbacks.push(function (next, error) {
                callbacks[index]().then(data => { each(data); next(); }).catch(err => error(err));
            });
        }
        for (let index = newCallbacks.length - 1; index >= 0; --index) {
            let element = newCallbacks[index];

            if (index !== newCallbacks.length - 1)
                newCallbacks[index] = function () {element(newCallbacks[index + 1], error)};
            else
                newCallbacks[index] = function () {element(then, error)}
        }

        return (newCallbacks[0]);
    }

    function invokeScript(scriptUrl, async = true) {
        return new Promise((resolve, reject) => {
            var script = document.createElement("script");

            script.setAttribute("type", "text/javascript");
            script.setAttribute("src", scriptUrl);
            script.setAttribute("async", async);

            document.body.appendChild(script);

            script.addEventListener("load", (event) => {
                resolve({status: true, loaded: scriptUrl, type: "script"});
            });

            script.addEventListener("error", (event) => {
                reject({
                    status: false,
                    message: `Failed to load script ${scriptUrl}`
                });
            });
        });
    }

    function init() {
        return ({
            listCallbackAlgorithm: listCallbackAlgorithm,
            invokeScript: invokeScript
        });
    }

    return ({
        getInstance: function () {
            if (instance === null)
                instance = init();
            return (instance);
        }
    });
})();

var __appHandler = (() => {
    var instance = null;

    function init(toPreload) {
        var preLoader = __preLoader.getInstance();
        var loaded = false;
        var errorStack = [];
        var loading = null;
        var library;

        function buildLoader(json) {
            var callbackList = []

            for (let index = 0; index < json.scripts.length; index++)
                callbackList.push(() => {return (preLoader.invokeScript(json.scripts[index]))});
            for (let index = 0; index < json.styles.length; index++)
                callbackList.push(() => {return (library.invokeCSS(json.styles[index]))});
            for (let index = 0; index < json.images.length; index++)
                callbackList.push(() => {return (library.loadImageAsset(json.images[index]))});
            for (let index = 0; index < json.UIs.length; index++)
                callbackList.push(() => {return (library.loadUi(json.UIs[index]))});
            for (let index = 0; index < json.JSONs.length; index++)
                callbackList.push(() => {return (library.loadJSON(json.JSONs[index]))});
            return (callbackList);
        }

        preLoader.listCallbackAlgorithm([
            () => {return preLoader.invokeScript("/lib/lloader.js");},
            () => {return new Promise((resolve, reject) => {library = __lloader.getInstance(); resolve({status: true, loaded: "appLibrary", type: "dynamic"})})},
            () => {return library.loadJSON(toPreload);},
        ],
        (data) => {
            loading = data;
        },
        () => {
            var builded = buildLoader(loading.content);

            if (builded.length !== 0) {
                preLoader.listCallbackAlgorithm(builded, data => {loading = data}, () => {
                    loaded = true;
                    loading = null;
                }, err => {
                    errorStack.push(err);
                    loading = null;
                })();
            } else {
                loaded = true;
                loading = null;
            }
        }, (err) => {
            errorStack.push(err);
            loading = null;
        })();

        function callWrapper(callback) {
            if (!loaded)
                throw new Error("appNotLoaded");
            return (callback);
        }

        function buildStandalone(toBuild, replacerText = {}, replacerHTML = {}, imagesAsset = {}) {
            var items = library.getUI(toBuild);
            var extracted = [];

            if (!items)
                return [];
            if (items.children.length === 1) {
                var temp = items.children[0].cloneNode(true);

                Object.keys(replacerHTML).forEach(x => {
                    temp.innerHTML = temp.innerHTML.replaceAll(x, replacerHTML[x]);
                });
                Object.keys(replacerText).forEach(x => {
                    stack = [temp];

                    while (stack.length) {
                        Array.from(stack.pop().childNodes).forEach(text => {
                            if (text.nodeType !== Node.TEXT_NODE) {
                                stack.push(text);
                                return;
                            }
                            text.textContent = text.textContent.replaceAll(x, replacerText[x]);
                        });
                    }
                });
                Object.keys(imagesAsset).forEach(x => {
                    Array.from(temp.querySelectorAll(x)).forEach(dom => {
                        dom.appendChild(imagesAsset[x].cloneNode());
                    });
                });

                extracted.push(temp);
                return (extracted);
            }
            Array.from(items.children).forEach(element => {
                var temp = element.cloneNode(true);

                Object.keys(replacerHTML).forEach(x => {
                    temp.innerHTML = temp.innerHTML.replaceAll(x, replacerHTML[x]);
                });
                Object.keys(replacerText).forEach(x => {
                    stack = [temp];

                    while (stack.length) {
                        Array.from(stack.pop().childNodes).forEach(text => {
                            if (text.nodeType !== Node.TEXT_NODE) {
                                stack.push(text);
                                return;
                            }
                            text.textContent = text.textContent.replaceAll(x, replacerText[x]);
                        });
                    }
                });
                Object.keys(imagesAsset).forEach(x => {
                    Array.from(temp.querySelectorAll(x)).forEach(dom => {
                        dom.appendChild(imagesAsset[x].cloneNode());
                    });
                });
                extracted.append(temp);
            });
            return (extracted);
        }

        function build(toBuild, parent, replacerText = {}, replacerHTML = {}, imagesAsset = {}, clearParent = false) {
            if (!parent)
                parent = document.getElementById("app");
            if (!parent)
                parent = document.body;
            if (clearParent)
                parent.innerHTML = "";
            var i = 0;
            var last = null;

            buildStandalone(toBuild, replacerText, replacerHTML, imagesAsset).forEach((x) => {
                last = parent.appendChild(x);
                i += 1;
            });
            return (i == 1 ? last : parent);
        }

        return ({
            isLoaded: function () {
                return (loaded);
            },
            hasError: function () {
                return (errorStack.length !== 0);
            },
            getError: function () {
                return (errorStack.pop());
            },
            onReady: function (callback, load, error) {
                var interval = setInterval(() => {if (loaded) {clearInterval(interval); callback()} else { if (this.hasError()) {clearInterval(interval); error(this.getError());} else { load(loading) } }}, 0);
            },
            getLibrary: function () {
                return (library);
            },
            setTitle: function (text) {
                document.title = text;
            },
            build: build,
            buildStandalone: buildStandalone
        });
    }

    return ({
        getInstance: function (toPreload) {
            if (instance === null)
                instance = init(toPreload);
            return (instance);
        }
    });
})();
