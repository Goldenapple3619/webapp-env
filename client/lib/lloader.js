__lloader = (() => {
    var instance = null;

    var images = {};
    var UIs = {};
    var JSONs = {};

    function invokeCSS(cssUrl) {
        return new Promise((resolve, reject) => {
            var style = document.createElement("link");

            style.setAttribute("type", "text/css");
            style.setAttribute("rel", "stylesheet");
            style.setAttribute("href", cssUrl);

            document.getElementsByTagName("head")[0].appendChild(style);

            style.addEventListener("load", (event) => {
                resolve({status: true, loaded: cssUrl, type: "style"});
            });

            style.addEventListener("error", (event) => {
                reject({
                    status: false,
                    message: `Failed to load style ${cssUrl}`
                });
            });
        });
    }

    function request(url, body = undefined, method = "GET", headers = {}) {
        return new Promise((resolve, reject) => {
            var req = (window.XMLHttpRequest ? new XMLHttpRequest : new ActiveXObject("Microsoft.XMLHTTP"));

            req.open(method, url, 1);
            Object.keys(headers).forEach((x) => {
                req.setRequestHeader(x, headers[x]);
            });
            req.withCredentials = true;
            req.onreadystatechange = () => {
                if (req.readyState === XMLHttpRequest.DONE && req.status >= 200 && req.status <= 299) {
                    resolve({status: true, loaded: url, type: "url", request: req});
                } else if (req.readyState === XMLHttpRequest.DONE) {
                    reject({status: false, request: req, message: `invalid response code from ${method} ${url} (code: ${req.status})`});
                }
            }
            req.onerror = () => {
                reject({status: false, message: `unknown error when requesting ${method} ${url}`});
            }
            req.send(body);
        });
    }

    function loadJSON(url) {
        return new Promise((resolve, reject) => {
            if (JSONs[url]) {
                resolve({status: true, loaded: url, type: "json", content: JSONs[url]});
                return;
            }

            request(url).then(data => {
                JSONs[url] = JSON.parse(data.request.responseText);
                resolve({status: true, loaded: url, type: "json", content: JSONs[url]});
            }).catch(err => {
                reject({status: false, message: `Failed to load json ${url}`});
            });
        });
    }

    function loadUi(url) {
        return new Promise((resolve, reject) => {
            request(url).then(data => {
                var temp;

                if (UIs[url]) {
                    resolve({status: true, loaded: url, type: "ui", content: UIs[url]});
                    return;
                }

                temp = document.createElement('div');

                temp.style.width = "100%";
                temp.style.height = "100%";
                temp.innerHTML = data.request.responseText;
                UIs[url] = temp;
                resolve({status: true, loaded: url, type: "ui", content: temp});
            }).catch(err => {
                reject({status: false, message: `Failed to load ui ${url}`});
            });
        });
    }

    function loadImageAsset(assetUrl) {
        return new Promise((resolve, reject) => {
            var image = new Image();

            if (images[assetUrl]) {
                resolve({status: true, loaded: assetUrl, type: "image", content: images[assetUrl]});
                return;
            }

            image.setAttribute("src", assetUrl);
            images[assetUrl] = image;

            image.addEventListener("load", (event) => {
                resolve({status: true, loaded: assetUrl, type: "image", content: image});
            });

            image.addEventListener("error", (event) => {
                reject({
                    status: false,
                    message: `Failed to load image ${assetUrl}`
                });
            });
        });
    }

    function init() {
        return ({
            invokeCSS: invokeCSS,
            loadImageAsset: loadImageAsset,
            loadUi: loadUi,
            request: request,
            loadJSON: loadJSON,
            getImageAsset: function (assetUrl) {
                return (images[assetUrl]);
            },
            getUI: function (url) {
                return (UIs[url]);
            },
            getJSON: function (url) {
                return (JSONs[url]);
            }
        });
    }

    return ({
        getInstance: function () {
            if (instance === null)
                this.instance = init();

            return (this.instance);
        }
    });
})();
