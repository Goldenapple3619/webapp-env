const path = require("node:path");

class Loader {
    constructor(files = []) {
        this.files = files;
    }

    load(callback) {
        for (const file of this.files)
            callback(require(path.resolve(__dirname, "..", file)), file);
    }
}

module.exports = { Loader };
