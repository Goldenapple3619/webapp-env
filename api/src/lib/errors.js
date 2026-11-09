class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

const badRequest = (message = "bad_request", details) => new HttpError(400, message, details);
const unauthorized = (message = "token_verification_ko") => new HttpError(401, message);
const forbidden = (message = "forbidden") => new HttpError(403, message);
const notFound = (message = "not_found") => new HttpError(404, message);
const conflict = (message = "conflict") => new HttpError(409, message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
