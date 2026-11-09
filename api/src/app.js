const express = require("express");

class App {
    constructor(host = "0.0.0.0", port = 80) {
        this._app = express();
        this._host = host;
        this._port = port;
        this._server = null;
    }

    getExpressApp() {
        return this._app;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this._server = this._app.listen(this._port, this._host, () => resolve({ status: true, data: null }));
            this._server.once("error", (e) => reject({ status: false, err: e }));
            this._server.requestTimeout = 0;
            this._server.headersTimeout = 20_000;
            this._server.keepAliveTimeout = 65_000;
        });
    }

    close({ graceMs = 8_000 } = {}) {
        return new Promise((resolve) => {
            if (!this._server)
                return resolve();

            const server = this._server;
            const force = setTimeout(() => server.closeAllConnections(), graceMs);

            force.unref();
            server.close(() => {
                clearTimeout(force);
                resolve();
            });
            server.closeIdleConnections();
        });
    }
}

module.exports = { App };
