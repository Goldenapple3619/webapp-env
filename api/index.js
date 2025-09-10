const { db } = require("./config/db.js");
const { app } = require("./config/app.js");

function main() {
    db.connect().then(() => {
        console.log(`[*] Connected to db.`);

        app.connect().then(() => {
            console.log(`[*] App listening.`);
        }).catch((err) => {
            console.log(`[-] Failed to listen app '${err.err}'.`);
            process.exit(1);
        });
    }).catch((err) => {
        console.log(`[-] Failed to connect to db '${err.err}'.`);
        process.exit(1);
    });
}

main();
