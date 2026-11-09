const { DB } = require("../src/db.js");
const { config } = require("./env.js");

module.exports = { db: new DB(config.db) };
