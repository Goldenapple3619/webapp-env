class User {
    static SCHEMA = {username: 'string', token: 'string', password: 'string', id: 'id', creation_date: 'string'};

    constructor(username, token = null, password = "", id = undefined, creationDate = (new Date())) {
        this.username = username;
        this.token = token;
        this.password = password;
        this.id = id;
        this.creationDate = creationDate;
    }

    toObject() {
        return ({
            username: this.username,
            token: this.token,
            password: this.password,
            id: this.id,
            creation_date: this.creationDate
        });
    }
}

module.exports = {
    User: User
};
