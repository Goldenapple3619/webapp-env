const methodOverride = require('method-override');
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

const { App } = require("../src/app.js");
const { Loader } = require('../src/loader.js');

const { loadedRoutes } = require('./router.js');

const { fs } = require("fs");

const middlewares = new Loader(["./middleware/optionRequest.js", "./middleware/notFound.js", "./middleware/notLogin.js"]);
const routes = new Loader(["./routes/handcheck.js", "./routes/sockets.js", "./routes/account.js"]);

let myApp = new App(
    "0.0.0.0",
    80
);
let app = myApp.getExpressApp();

app.use(bodyParser.json({ extended: true }));
app.use(cookieParser());
app.use(methodOverride('X-HTTP-Method-Override'));
middlewares.load((loaded) => {
    if (!loaded.middlewares) {
        console.log(`[!] Empty middleware.`)
        return
    }
    for (var middleware of loaded.middlewares) {
        var temp = middleware;

        app.use(temp.callback);

        console.log(`[*] Loaded middleware ${temp.callback.name}.`);
    }
});
routes.load((loaded) => {
    if (!loaded.routes) {
        console.log(`[!] Empty routes.`)
        return
    }
    for (var route of loaded.routes) {
        var temp = route;
        var method = temp.method.toUpperCase();
        var path = temp.path;
        var callback = temp.callback;

        loadedRoutes[path + ' ' + method] = route;

        if (method === "GET")
            app.get(path, callback);
        if (method === "POST")
            app.post(path, callback);
        if (method === "PUT")
            app.put(path, callback);
        if (method === "DELETE")
            app.delete(path, callback);
        if (method === "ALL")
            app.all(path, callback);

        console.log(`[*] Loaded route (${method} ${path}) ${callback.name}.`);
    }
});


module.exports = {
    app: myApp
};
