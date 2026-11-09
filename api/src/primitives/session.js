class Session {
    constructor(row) {
        this.id = row.id;
        this.userId = row.user_id;
        this.userAgent = row.user_agent;
        this.ip = row.ip;
        this.createdAt = row.created_at;
        this.lastUsedAt = row.last_used_at;
        this.expiresAt = row.expires_at;
    }

    toPublic(currentId) {
        return {
            id: this.id,
            current: this.id === currentId,
            userAgent: this.userAgent,
            ip: this.ip,
            createdAt: this.createdAt,
            lastUsedAt: this.lastUsedAt,
            expiresAt: this.expiresAt,
        };
    }
}

module.exports = { Session };
