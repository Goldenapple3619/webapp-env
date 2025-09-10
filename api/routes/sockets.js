const { db } = require("../config/db.js");

const { Server } = require("../src/primitives/server.js");

function getWSockets(req, res) {
    db.requestDAO("wsockets", Server).then((data) => {
        res.status(200).json({"message": "fetch_ok", "wssockets": data.data.map((x) => {return x.toObject();}), "code": 200});
    }).catch((err) => {
        res.status(500).json({"message": String(err.err), "code": 500});
    });
};

module.exports = {
    routes: [
        {
            method: 'get',
            path: '/wsockets',
            protected: false,
            callback: getWSockets
        }
    ]
}
