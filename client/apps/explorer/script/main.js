if (!document.__explorerScript) {
document.__explorerScript = (() => {
    function init() {
        var itemPool;
        var pathDom;
        var openCallback;
        var actualPath = "/";

        var items = [];

        function clearItem() {
            items.forEach(x => {
                x.dom.remove();
            });
            items = [];
        }

        function addItem(name, path, size, type, icon, creationDate, modificationDate, template = "UI/item.html") {
            if (!icon)
                icon = type === "folder" ? "/assets/images/default_folder.png" : "/assets/images/default_file.png";

            document.app.getLibrary().loadImageAsset(icon).then(data => {}).catch(err => {});

            document.app.getLibrary().loadImageAsset(icon).then(data => {
                data.content.width = 64;
                data.content.height = 64;
                var item = items[items.push({
                    name: name,
                    path: path,
                    size: size,
                    type: type,
                    icon: data.content,
                    creationDate: creationDate,
                    modificationDate: modificationDate,
                    dom: document.app.build(template, itemPool, {
                        "${FILE_NAME}": name
                    }, {
                    }, {
                        ".img-container-item": data.content
                    })
                }) - 1];

                item.dom.addEventListener("dblclick", (ev) => {
                    if (openCallback)
                        openCallback(item);
                });
            });
        }

        function setPath(path) {
            actualPath = path;
            if (pathDom)
                pathDom.innerText = path;
        }

        function setItemPoolDom(dom) {
            itemPool = dom;
        }

        function setPathDom(dom) {
            pathDom = dom;
        }

        function setCallbackOpen(callback) {
            openCallback = callback;
        }

        function nonStandaloneDestroy() {
            clearItem();
        }

        return ({
            setCallbackOpen: setCallbackOpen,
            setItemPoolDom: setItemPoolDom,
            setPathDom: setPathDom,
            addItem: addItem,
            setPath: setPath,
            clearItem: clearItem,
            getPath: function () {
                return (actualPath);
            },
            nonStandaloneDestroy: nonStandaloneDestroy
        });
    }

    return ({
        new: function () {
            return (init());
        }
    });
})();
}
