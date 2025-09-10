const express = require("express");

class App {
    constructor(host = '0.0.0.0', port = 80) {
        this._app = express();
        this._host = host;
        this._port = port;
    }

    getExpressApp() {
        return (this._app);
    }

    connect() {
        let app = this._app;
        let port = this._port;
        let host = this._host;

        return (new Promise((resolve, reject) => {
            app.on('error', (e) => {
                reject({status: false, err: e});
            });

            app.listen(port, host, () => {
                resolve({status: true, data: null});
            });
        }));
    }
}

module.exports = {
    App: App
};
