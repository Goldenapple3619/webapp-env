const helmet = require("helmet");
const { config } = require("../config/env.js");

const crossOrigin = config.cors.origins.length > 0;

function noStore(_req, res, next) {
    res.setHeader("Cache-Control", "no-store");
    next();
}

module.exports = {
    stage: "pre",
    middlewares: [
        { callback: noStore },
        {
            callback: helmet({
                contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
                crossOriginResourcePolicy: { policy: crossOrigin ? "cross-origin" : "same-origin" },
                referrerPolicy: { policy: "no-referrer" },
            }),
        },
    ],
};
