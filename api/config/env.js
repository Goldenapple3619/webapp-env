const MB = 1024 * 1024;
const env = process.env;
const problems = [];

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${name} must be an integer${Number.isFinite(min) || Number.isFinite(max) ? ` in [${min}, ${max}]` : ""}, got '${raw}'`);
        return fallback;
    }
    return n;
}

function bool(name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (/^(1|true|yes|on)$/i.test(raw.trim())) return true;
    if (/^(0|false|no|off)$/i.test(raw.trim())) return false;
    problems.push(`${name} must be true or false, got '${raw}'`);
    return fallback;
}

function choice(name, fallback, allowed) {
    const raw = (env[name] || "").trim().toLowerCase();
    if (raw === "") return fallback;
    if (!allowed.includes(raw)) {
        problems.push(`${name} must be one of ${allowed.join(", ")}, got '${env[name]}'`);
        return fallback;
    }
    return raw;
}

const list = (name) => (env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);

function origin(name, value) {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) throw new Error("not http(s)");
        return url.origin;
    } catch {
        problems.push(`${name} contains '${value}', which is not an origin like https://app.example.com`);
        return null;
    }
}

const publicOrigin = env.PUBLIC_URL ? origin("PUBLIC_URL", env.PUBLIC_URL) : null;
const corsOrigins = [...new Set([publicOrigin, ...list("CORS_ORIGINS").map((o) => origin("CORS_ORIGINS", o))].filter(Boolean))];

const cookieSecureRaw = (env.COOKIE_SECURE || "auto").trim().toLowerCase();

if (!["auto", "true", "false", "1", "0", "yes", "no", "on", "off"].includes(cookieSecureRaw))
    problems.push(`COOKIE_SECURE must be auto, true or false, got '${env.COOKIE_SECURE}'`);

const trustProxyRaw = env.TRUST_PROXY;
const trustProxy = trustProxyRaw === undefined || trustProxyRaw === "" ? 1 : /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : trustProxyRaw;

const config = {
    env: env.NODE_ENV || "production",
    host: "0.0.0.0",
    port: int("API_INTERNAL_PORT", 8000, { min: 0, max: 65535 }),
    logLevel: choice("LOG_LEVEL", "info", ["debug", "info", "warn", "error"]),

    trustProxy,
    publicOrigin,

    db: {
        user: env.POSTGRES_USER,
        host: env.DB_HOST || "db",
        port: int("DB_PORT", 5432, { min: 1, max: 65535 }),
        database: env.POSTGRES_DB,
        password: env.POSTGRES_PASSWORD,
        max: int("DB_POOL_SIZE", 10, { min: 1, max: 200 }),
    },

    systemRoot: env.SYSTEM_ROOT || "/mnt/system",
    maxUploadBytes: int("MAX_UPLOAD_MB", 2048, { min: 1, max: 1024 * 1024 }) * MB,
    maxZipsPerUser: int("MAX_CONCURRENT_ZIPS", 2, { min: 1, max: 20 }),

    auth: {
        pepper: env.SALT || "",
        jwtSecret: env.JWT_SECRET || "",
        issuer: "webapp-env",
        accessTtl: int("ACCESS_TOKEN_TTL", 900, { min: 60, max: 86400 }),
        sessionDays: int("SESSION_TTL_DAYS", 30, { min: 1, max: 365 }),
        sessionMaxDays: int("SESSION_MAX_DAYS", 90, { min: 1, max: 3650 }),
        refreshGraceSeconds: 15,
        maxSessionsPerUser: int("MAX_SESSIONS_PER_USER", 20, { min: 1, max: 1000 }),
        allowRegistration: bool("ALLOW_REGISTRATION", true),
        bcryptCost: int("BCRYPT_COST", 12, { min: 4, max: 15 }),
    },

    cookies: {
        secure: cookieSecureRaw === "auto" ? "auto" : /^(true|1|yes|on)$/.test(cookieSecureRaw),
        sameSite: choice("COOKIE_SAMESITE", "auto", ["auto", "strict", "lax", "none"]),
        pathPrefix: "/api",
    },

    cors: { origins: corsOrigins },

    rateLimit: {
        enabled: !/^(off|0|false|no)$/i.test(env.RATE_LIMITS || "on"),
        loginPerMinute: int("RATE_LIMIT_LOGIN_PER_MINUTE", 10, { min: 1, max: 10000 }),
        registerPerHour: int("RATE_LIMIT_REGISTER_PER_HOUR", 10, { min: 1, max: 10000 }),
        globalPerMinute: int("RATE_LIMIT_GLOBAL_PER_MINUTE", 1200, { min: 10, max: 1_000_000 }),
    },
};

if (!/^(off|0|false|no|on|1|true|yes)$/i.test(env.RATE_LIMITS || "on")) problems.push(`RATE_LIMITS must be on or off, got '${env.RATE_LIMITS}'`);

function validate() {
    const found = [...problems];
    for (const key of ["user", "database", "password"])
        if (!config.db[key])
            found.push(`database ${key === "database" ? "name" : key} is missing (POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD)`);

    if (config.auth.jwtSecret.length < 32)
        found.push("JWT_SECRET must be set to a random string of at least 32 characters (try: openssl rand -hex 48)");

    if (config.auth.sessionDays > config.auth.sessionMaxDays)
        found.push("SESSION_TTL_DAYS cannot exceed SESSION_MAX_DAYS");
    if (config.cookies.sameSite === "none" && config.cookies.secure === false)
        found.push("COOKIE_SAMESITE=none requires COOKIE_SECURE");
    if (found.length)
        throw new Error(`invalid configuration:\n  - ${found.join("\n  - ")}`);
    if (!config.auth.pepper)
        console.warn("[!] SALT is empty: passwords are hashed without a pepper.");
    return config;
}

module.exports = { config, validate };
