const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PARTITION = "persist:webapp-env";
const ICON = path.join(__dirname, "..", "build", "icon.png");
const LAUNCHER = path.join(__dirname, "..", "ui", "launcher.html");
const FALLBACK_APPS = [
    { id: "explorer", name: "Explorer", dir: "/apps/explorer/", size: [880, 560] },
    { id: "music", name: "Music", dir: "/apps/musicPlayer/", size: [440, 680], singleton: true },
    { id: "code", name: "Code", dir: "/apps/code/", size: [1000, 640], singleton: true },
    { id: "terminal", name: "Terminal", dir: "/apps/terminal/", size: [760, 480] },
];

app.commandLine.appendSwitch("enable-features", "HardwareMediaKeyHandling,MediaSessionService");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const parseArgs = (list) => Object.fromEntries(list.filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.length ? v.join("=") : true]; }));
const argv = parseArgs(process.argv.slice(1));
const configFile = () => path.join(app.getPath("userData"), "config.json");
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return {}; } }
function saveConfig(cfg) { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2)); }

let config = {};
let registry = FALLBACK_APPS;
let launcher = null, tray = null, quitting = false, desktopWindow = null;
const singletons = new Map();
const all = new Set();

const serverUrl = () => (config.server || "").replace(/\/+$/, "");
const serverOrigin = () => { try { return new URL(serverUrl()).origin; } catch { return null; } };

function normaliseServer(input) {
    let v = String(input || "").trim();

    if (!v)
        throw new Error("Enter a server address.");
    if (!/^https?:\/\//i.test(v))
        v = (/^(localhost|127\.|\[::1\])/i.test(v) ? "http://" : "https://") + v;

    const u = new URL(v);

    if (!["http:", "https:"].includes(u.protocol))
        throw new Error("Only http(s) servers are supported.");

    return u.origin;
}

async function probe(origin) {
    const res = await net.fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(6000) });

    if (!res.ok)
        throw new Error(`The server answered ${res.status}.`);

    const body = await res.json().catch(() => ({}));

    if (body.status !== "ok")
        throw new Error("That does not look like a webapp-env server.");
}

async function loadRegistry() {
    try {
        const res = await net.fetch(`${serverUrl()}/apps/registry.json`, { signal: AbortSignal.timeout(6000) });
        const list = (await res.json()).apps.filter((a) => !a.builtin && !a.hidden);

        registry = list.length ? list : FALLBACK_APPS;
    } catch {
        registry = FALLBACK_APPS;
    }
}

function secureOptions(extra = {}) {
    return {
        icon: ICON,
        show: false,
        backgroundColor: "#dcd4f0",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            partition: PARTITION,
            spellcheck: false,
            backgroundThrottling: false,
        },
        ...extra,
    };
}

function lockNavigation(win) {
    const inside = (url) => {
        try {
            return new URL(url).origin === serverOrigin();
        } catch {
            return false;
        }
    };

    win.webContents.on("will-navigate", (event, url) => {
        if (inside(url))
            return;

        event.preventDefault();

        if (/^https?:/i.test(url))
            shell.openExternal(url);
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);

            if (u.origin === serverOrigin()) {
                const found = registry.find((a) => u.pathname.startsWith(a.dir));

                if (found) {
                    let args = {};

                    try {
                        args = JSON.parse(u.searchParams.get("args") || "{}");
                    } catch {

                    }

                    openApp(found.id, args);
                } else if (u.pathname.startsWith("/desktop"))
                    openDesktop();
                else
                    shell.openExternal(url);
            } else if (/^https?:/i.test(url))
                shell.openExternal(url);
        } catch {

        }

        return { action: "deny" };
    });
}

function track(win) {
    all.add(win);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => all.delete(win));
    lockNavigation(win);

    return win;
}

function showLauncher() {
    if (launcher && !launcher.isDestroyed()) {
        launcher.show();
        launcher.focus();
        return launcher;
    }

    launcher = new BrowserWindow(secureOptions({ width: 460, height: 560, resizable: false, maximizable: false, title: "Webapp Env" }));
    launcher.removeMenu();
    launcher.once("ready-to-show", () => launcher.show());
    launcher.on("closed", () => { launcher = null; });
    all.add(launcher);
    launcher.on("closed", () => all.delete(launcher));
    launcher.loadFile(LAUNCHER);

    return launcher;
}

function openApp(id, args = {}) {
    if (!serverUrl()) {
        showLauncher();
        return;
    }

    const def = registry.find((a) => a.id === id);

    if (!def)
        return;

    const existing = def.singleton && singletons.get(id);

    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized())
            existing.restore();

        existing.show(); existing.focus();

        if (Object.keys(args).length)
            existing.webContents.send("suite:intent", args);

        return;
    }

    const [w, h] = def.size || [900, 600];
    const win = track(new BrowserWindow(secureOptions({ width: w, height: h, title: def.name })));

    win.removeMenu();

    if (def.singleton) {
        singletons.set(id, win);
        win.on("closed", () => singletons.delete(id));
    }

    const qs = Object.keys(args).length ? `?args=${encodeURIComponent(JSON.stringify(args))}` : "";

    win.loadURL(`${serverUrl()}${def.dir}${qs}`);
}

function openDesktop() {
    if (!serverUrl()) {
        showLauncher();
        return;
    }

    if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.show();
        desktopWindow.focus();
        return;
    }

    desktopWindow = track(new BrowserWindow(secureOptions({ width: 1280, height: 800, title: "Virtual desktop" })));
    desktopWindow.removeMenu();
    desktopWindow.on("closed", () => { desktopWindow = null; });
    desktopWindow.loadURL(`${serverUrl()}/desktop/`);
}

function buildTray() {
    try {
        tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
    } catch {
        return;
    }

    tray.setToolTip("Webapp Env");
    const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Virtual desktop", click: openDesktop, enabled: !!serverUrl() },
        { type: "separator" },
        ...registry.map((a) => ({ label: a.name, click: () => openApp(a.id), enabled: !!serverUrl() })),
        { type: "separator" },
        { label: "Launcher / server…", click: showLauncher },
        { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]));
    refresh();
    tray.on("click", showLauncher);
    app.on("suite-registry-changed", refresh);
}

function buildAppMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "editMenu" },
        { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
        { role: "windowMenu" },
    ]));
}

const fromLauncher = (event) => !!launcher && !launcher.isDestroyed() && event.sender === launcher.webContents;
const isOurPage = (event) => { try { return new URL(event.senderFrame.url).origin === serverOrigin() || event.sender === launcher?.webContents; } catch { return false; } };

ipcMain.handle("suite:open-app", (event, id, args) => {
    if (!isOurPage(event) || typeof id !== "string")
        return;

    openApp(id, args && typeof args === "object" ? args : {});
});
ipcMain.handle("suite:open-desktop", (event) => {
    if (isOurPage(event))
        openDesktop();
});
ipcMain.handle("suite:quit", (event) => {
    if (fromLauncher(event)) {
        quitting = true;
        app.quit();
    }
});
ipcMain.handle("suite:state", (event) => {
    if (!fromLauncher(event))
        return null;

    return {
        server: serverUrl(), apps: registry.map(({ id, name }) => ({ id, name })), version: app.getVersion(), platform: process.platform,
        insecure: !!serverUrl() && !serverUrl().startsWith("https:") && !/^http:\/\/(localhost|127\.|\[::1\])/.test(serverUrl()),
    };
});

ipcMain.handle("suite:set-server", async (event, url) => {
    if (!fromLauncher(event))
        return { ok: false, error: "forbidden" };

    try {
        const origin = normaliseServer(url);

        await probe(origin);
        config.server = origin;
        saveConfig(config);
        await loadRegistry();
        app.emit("suite-registry-changed");
        launcher?.webContents.send("suite:state-changed");

        return { ok: true, server: origin };
    } catch (err) {
        return { ok: false, error: err.name === "TimeoutError" ? "The server did not answer in time." : err.message || "Cannot reach that server." };
    }
});

function handleArgs(args) {
    if (args.desktop)
        return openDesktop();
    if (args.app)
        return openApp(String(args.app), args.path ? { path: String(args.path) } : {});

    showLauncher();
}

if (!app.requestSingleInstanceLock())
    app.quit();
else {
    app.on("second-instance", (_event, commandLine) => handleArgs(parseArgs(commandLine.slice(1))));

    app.whenReady().then(async () => {
        const wanted = argv.server || process.env.WEBAPP_ENV_SERVER;

        config = loadConfig();

        if (wanted && wanted !== true) {
            try {
                config.server = normaliseServer(wanted);
                saveConfig(config);
            } catch {

            }
        }

        session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, permission, callback) => callback(["clipboard-sanitized-write", "fullscreen"].includes(permission)));

        buildAppMenu();

        if (serverUrl())
            await loadRegistry();

        buildTray();
        handleArgs(argv);
    });

    app.on("window-all-closed", () => { if (quitting || !tray) app.quit(); });
    app.on("activate", () => { if (!all.size) showLauncher(); });
    app.on("before-quit", () => { quitting = true; });
}
