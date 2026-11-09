const express = require("express");
const cookieParser = require("cookie-parser");

const { App } = require("../src/app.js");
const { Loader } = require("../src/loader.js");
const { config } = require("./env.js");
const { router, loadedRoutes } = require("./router.js");
const limits = require("../src/lib/limits.js");
const { authenticate } = require("../middleware/auth.js");
const log = require("../src/lib/logger.js");

const middlewares = new Loader(["./middleware/requestLog.js", "./middleware/security.js", "./middleware/cors.js", "./middleware/errors.js"]);
const routes = new Loader(["./routes/handcheck.js", "./routes/sockets.js", "./routes/auth.js", "./routes/files.js"]);

const myApp = new App(config.host, config.port);
const app = myApp.getExpressApp();

app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

const post = [];
middlewares.load((loaded) => {
    for (const middleware of loaded.middlewares) {
        if (loaded.stage === "post") post.push(middleware);
        else app.use(middleware.callback);
    }
});

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

routes.load((loaded, file) => {
    for (const route of loaded.routes) {
        const method = route.method.toLowerCase();

        const named = [].concat(route.limit || []).map((name) => {
            if (!limits[name])
                throw new Error(`route ${route.method.toUpperCase()} ${route.path} uses an unknown limiter '${name}'`);
            return limits[name];
        });
        const handlers = [...(route.protected ? [authenticate({ allowCookie: route.allowCookie })] : []), ...named, ...(route.middleware || []), route.callback];

        router[method](route.path, ...handlers);
        loadedRoutes[`${method.toUpperCase()} ${route.path}`] = route;
        log.debug("route loaded", { method: method.toUpperCase(), path: route.path, file });
    }
});

app.use("/api", limits.global, router);
for (const middleware of post) app.use(middleware.callback);

module.exports = { app: myApp };
