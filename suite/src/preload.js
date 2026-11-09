const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nativeShell", {
    isNative: true,
    platform: process.platform,
    openApp: (id, args) => ipcRenderer.invoke("suite:open-app", String(id), args && typeof args === "object" ? args : {}),
    openDesktop: () => ipcRenderer.invoke("suite:open-desktop"),
});

ipcRenderer.on("suite:intent", (_event, args) => {
    window.postMessage({ type: "intent", args }, location.origin);
});

if (location.protocol === "file:") {
    contextBridge.exposeInMainWorld("suite", {
        state: () => ipcRenderer.invoke("suite:state"),
        setServer: (url) => ipcRenderer.invoke("suite:set-server", String(url)),
        openApp: (id) => ipcRenderer.invoke("suite:open-app", String(id), {}),
        openDesktop: () => ipcRenderer.invoke("suite:open-desktop"),
        quit: () => ipcRenderer.invoke("suite:quit"),
        onState: (cb) => ipcRenderer.on("suite:state-changed", () => cb()),
    });
}
