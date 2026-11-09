# Webapp Env desktop suite

Run the apps on your **real desktop** as well as in the browser's virtual desktop.

* a launcher + tray icon (Explorer, Music, Code, Terminal, or the whole virtual desktop),
* every app in its own native window, all sharing **one sign-in**,
* apps cooperate: *Open in Code* in the Explorer focuses (or opens) the Code window, *Play in Music*
  sends the file to the running player, `open file.txt` in the Terminal launches the right app,
* hardware media keys / headset buttons control the Music window.

The apps still work on your **server-side** files: this is a native shell around the same web client
(the same code runs in a browser tab, in a virtual-desktop window and here). It does not touch the
local disk.

## Run

```bash
cd suite
npm install
npm start -- --server=http://localhost:8080
```

Command line (the first instance receives the arguments of later launches):

| flag | effect |
|---|---|
| `--server=URL` | server to use (saved; `WEBAPP_ENV_SERVER` works too) |
| `--desktop` | open the virtual desktop |
| `--app=code --path=/documents/a.txt` | open an app, optionally on a file |

## Build installers

```bash
npm run dist
```

Builds are **unsigned**: add your signing identity to the `build` block of `package.json` for distribution.

