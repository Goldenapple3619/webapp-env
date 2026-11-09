const { HttpError } = require("./errors.js");

function validate(schema, source = "body") {
    return (req, _res, next) => {
        const parsed = schema.safeParse(req[source] ?? {});

        if (!parsed.success) {
            const errors = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

            return next(new HttpError(400, "validation_error", errors));
        }
        Object.defineProperty(req, source, { value: parsed.data, writable: true, configurable: true });
        next();
    };
}

module.exports = { validate };
