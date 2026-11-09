class Server {
    static SCHEMA = { host: "string", priority: "number", label: "string" };

    constructor(host = "/ws", priority = 100, label = null) {
        this.host = host;
        this.priority = priority;
        this.label = label;
    }

    static fromRow(row) {
        return new Server(row.host, row.priority, row.label);
    }

    toObject() {
        return { host: this.host, priority: this.priority, label: this.label };
    }
}

module.exports = { Server };
