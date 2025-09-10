const { DB } = require("../src/db.js");

module.exports = {
    db: new DB(
        process.env.POSTGRES_USER,
        process.env.DB_HOST,
        process.env.POSTGRES_DB,
        process.env.POSTGRES_PASSWORD
    )
};
