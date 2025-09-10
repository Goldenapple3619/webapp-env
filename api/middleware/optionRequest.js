function handleOptionsRequests(req, res, next) {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
    res.header("Access-Control-Allow-Headers", "X-HTTP-Method-Override, Origin, X-Requested-With, Origin, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "PUT, GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Credentials", "true");
    if (req.method == "OPTIONS") {
        res.status(200).json({"message": "avaiable", "code": 200});
        return;
    }
    next();
}

module.exports = {
    middlewares: [
        {
            callback: handleOptionsRequests
        }
    ]
};
