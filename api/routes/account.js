const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const { db } = require("../config/db.js");

const { User } = require("../src/primitives/user.js");
const path = require('path');

const USERFS = [
    "/mnt/system/users",
    "/mnt/system/users/$USERID",
    "/mnt/system/users/$USERID/root",
    "/mnt/system/users/$USERID/root/documents",
    "/mnt/system/users/$USERID/root/desktop",
    "/mnt/system/users/$USERID/root/music",
    "/mnt/system/users/$USERID/root/videos",
    "/mnt/system/users/$USERID/root/downloads",
    "/mnt/system/users/$USERID/root/pictures",
    "/mnt/system/users/$USERID/appdata"
];

function connectAcc(req, res) {
    let username = req.body.username;

    if (!username)
        return res.status(401).json({message: "session_ko" , code: 401});

    db.requestDAO("users", User, "WHERE username=$1", [username]).then(data => {
        if (!data.data.length)
            return res.status(401).json({message: "session_ko" , code: 401});
        if (!bcrypt.compareSync(req.body.password + process.env.SALT, data.data[0].password))
            return res.status(401).json({message: "session_ko" , code: 401});
        res.status(200).json({"message": "session_ok", "token": data.data[0].token, "code": 200});
    }).catch(err => {
        res.status(500).json({"message": String(err), "code": 500});
    });
};

function verifyToken(req, res) {
    req.loggedUser.password = "[REDACTED]";
    req.loggedUser.token = "[REDACTED]";
    res.status(200).json({"message": "token_ok", "data": req.loggedUser, "code": 200});
};

function createUser(req, res) {
    let username = req.body.username;

    if (!username)
        return res.status(401).json({message: "user_creation_ko" , code: 401});

    let password = bcrypt.hashSync(req.body.password + process.env.SALT, 10);

    let user = new User(username, jwt.sign({username: username, date: new Date()}, process.env.SALT, { algorithm: 'HS256' }), password);

    db.writeDAO("users", user, User).then((data) => {
        USERFS.forEach((x) => {
            let temp = x.replaceAll("$USERID", data.data[0].id.toString());

            if (!fs.existsSync(temp))
                fs.mkdirSync(temp);
        });
        res.status(200).json({"message": "user_creation_ok", "token": data.data[0].token, "code": 200});
    }).catch((err) => {
        res.status(500).json({"message": String(err.err), "code": 500});
    });
}

function getFiles(req, res) {
    var value = path.resolve(path.join(`/mnt/system/users/${req.loggedUser.id}/root`, path.join(...req.params.path)));

    try {
        if (!value.startsWith(`/mnt/system/users/${req.loggedUser.id}/root`))
            return (res.status(404).json({message: `ressource ${value} not found.`, code: 404}));
        fs.accessSync(value, fs.constants.F_OK);
    } catch {
        return (res.status(404).json({message: `ressource ${value} not found.`, code: 404}));
    }
    res.status(200).sendFile(value);
}

function setToken(req, res) {
    res.cookie('authorization', req.query.token, {path: "/", httpOnly: true, maxAge: 271568425, sameSite: "None", secure: true, signed: false});
    res.redirect(301, req.query.redirect);
}

module.exports = {
    routes: [
        {
            method: 'post',
            path: '/connect',
            protected: false,
            callback: connectAcc
        },
        {
            method: 'get',
            path: '/settoken',
            protected: false,
            callback: setToken
        },
        {
            method: 'post',
            path: '/verify',
            protected: true,
            callback: verifyToken
        },
        {
            method: 'post',
            path: '/createUser',
            protected: false,
            callback: createUser
        },
        {
            method: 'get',
            path: '/my/*path',
            protected: true,
            callback: getFiles
        }
    ]
}
