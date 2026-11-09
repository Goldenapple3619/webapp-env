class User {
    static SCHEMA = { id: "id", username: "string", password: "string", creation_date: "string", last_login_at: "string" };

    constructor(username, password = "", id = undefined, creationDate = new Date(), lastLoginAt = null) {
        this.username = username;
        this.password = password;
        this.id = id;
        this.creationDate = creationDate;
        this.lastLoginAt = lastLoginAt;
    }

    static fromRow(row) {
        return new User(row.username, row.password, row.id, row.creation_date, row.last_login_at);
    }

    toObject() {
        return { id: this.id, username: this.username, password: this.password, creation_date: this.creationDate, last_login_at: this.lastLoginAt };
    }

    toPublic() {
        return { id: this.id, username: this.username, creationDate: this.creationDate, lastLoginAt: this.lastLoginAt };
    }
}

module.exports = { User };
