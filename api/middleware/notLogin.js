const { db } = require("../config/db.js");

const { User } = require("../src/primitives/user.js");

function notLogin(req, res, next) {
    var data = req.routeRegistered;

    if (data === undefined || !data.protected) {
        next();
        return;
    }

    console.log(req.cookies.authorization)
    if (req.cookies.authorization && !req.headers.authorization) {
        req.headers.authorization = req.cookies.authorization;
    }

    if (!req.headers.authorization) {
        res.status(401).json({message: "token_verification_ko", code: 401});
        return;
    }

    db.requestDAO("users", User, "WHERE token=$1", [req.headers.authorization]).then(data => {
        if (!data.data.length)
            return res.status(401).json({message: "token_verification_ko" , code: 401});
        req.loggedUser = data.data[0];
        next();
    }).catch(err => {
        return res.status(500).json({"message": String(err.err), "code": 500});
    });
}

module.exports = {
    middlewares: [
        {
            callback: notLogin
        }
    ]
}
