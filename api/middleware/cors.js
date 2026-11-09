const { isAllowedOrigin, isSameSite, hostOf } = require("../src/lib/origin.js");

function cors(req, res, next) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Range, Accept-Ranges, X-Request-Id, Retry-After, RateLimit");
        res.vary("Origin");
        if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Authorization, Content-Type");
            res.setHeader("Access-Control-Max-Age", "600");
            res.vary("Access-Control-Request-Headers");
            return res.status(204).end();
        }
    }
    next();
}

function originGuard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method))
        return next();

    const origin = req.headers.origin;
    const refuse = () => res.status(403).json({ message: "bad_origin", code: 403 });

    if (!origin)
        return req.headers["sec-fetch-site"] === "cross-site" ? refuse() : next();

    if (hostOf(origin) === null)
        return refuse();

    return isSameSite(req) || isAllowedOrigin(origin) ? next() : refuse();
}

module.exports = { stage: "pre", middlewares: [{ callback: cors }, { callback: originGuard }] };
