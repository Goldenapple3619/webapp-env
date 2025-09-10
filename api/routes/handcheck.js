function handcheckStatus(req, res) {
    res.status(200).json({"message": "handcheck_ok", "code": 200});
};

module.exports = {
    routes: [
        {
            method: 'get',
            path: '/handcheck',
            protected: false,
            callback: handcheckStatus
        }
    ]
}
