const { loadedRoutes } = require('../config/router.js');

function notFound(req, res, next) {
    const url = req.originalUrl.split('?')[0];
    const layer = req.app.router.stack.find(layer => {
        return (layer.route && layer.route.methods[req.method.toLowerCase()] && layer.matchers[0](url));
    });

    req.foundLayer = layer;

    if (!req.foundLayer) {
        res.status(404).json({message: "not_found", code: 404});
        return;
    }
    req.routeRegistered = loadedRoutes[`${layer.route.path} ${req.method.toUpperCase()}`];
    next();
}

module.exports = {
    middlewares: [
        {
            callback: notFound
        }
    ]
};