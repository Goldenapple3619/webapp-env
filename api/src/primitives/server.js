class Server {
    static SCHEMA = {host: 'string'};

    constructor(host = "127.0.0.1:2117") {
        this.host = host;
    }

    toObject() {
        return ({host: this.host});
    }
}

module.exports = {
    Server: Server
};
