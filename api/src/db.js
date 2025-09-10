const pg = require('pg');

class DB {
    constructor (user, host, database, password) {
        this._db = new pg.Client({
            user: user,
            host: host,
            database: database,
            password: password
        });
    }

    connect() {
        let db = this._db;

        return (new Promise((resolve, reject) => {
            db.connect(function(err) {
                if (err)
                    reject({status: false, err: err});
                resolve({status: true, data: null});
            });
        }));
    }

    requestDAO(table, classBase, extend="", parameters = []) {
        let db = this._db;

        return (new Promise((resolve, reject) => {
            db.query(`SELECT ${Object.keys(classBase.SCHEMA).join(', ')} FROM ${table}${extend ? " " + extend : ""};`, parameters, (err, result) => {
                let temp = [];

                if (err)
                    return reject({status: false, err: err});
                for (let i = 0; i < result.rows.length; ++i)
                    temp.push(new classBase(...Object.values(result.rows[i])));
                return resolve({status: true, data: temp});
            });
        }));
    }

    writeDAO(table, obj, classBase) {
        let db = this._db;

        return (new Promise((resolve, reject) => {
            let i = 0;
            let objObj = obj.toObject();

            db.query(`INSERT INTO ${table} (${Object.keys(classBase.SCHEMA).filter((x) => {return classBase.SCHEMA[x] != "id"}).join(', ')}) VALUES (${Object.keys(classBase.SCHEMA).filter((x) => {return classBase.SCHEMA[x] != "id"}).map((x) => {return `$${++i}`;})}) RETURNING ${Object.keys(classBase.SCHEMA).join(', ')};`, [...Object.keys(classBase.SCHEMA).filter((x) => {return classBase.SCHEMA[x] != "id"}).map((x) => {return objObj[x]})], (err, result) => {
                if (err)
                    return reject({status: false, err: err});
                if (result.rows.length === 0)
                    return reject({status: false, err: new pg.DatabaseError("nothing inserted")});
                return resolve({status: true, data: [new classBase(...Object.values(result.rows[0]))]})
            });
        }));
    }
}

module.exports = {
    DB: DB
};
