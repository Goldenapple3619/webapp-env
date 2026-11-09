const { db } = require("../config/db.js");
const { Server } = require("../src/primitives/server.js");

async function getWSockets(_req, res) {
    const { data } = await db.requestDAO("wsockets", Server, "WHERE enabled ORDER BY priority, host");
    const list = data.map((x) => x.toObject());

    res.status(200).json({ message: "fetch_ok", wsockets: list, wssockets: list, code: 200 });
}

module.exports = {
    routes: [{ method: "get", path: "/wsockets", protected: false, callback: getWSockets }],
};
