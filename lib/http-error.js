class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, "BAD_REQUEST", message, details);
const unauthorized = (message = "Authentication is required") =>
  new HttpError(401, "UNAUTHORIZED", message);
const forbidden = (message = "You do not have permission to perform this action") =>
  new HttpError(403, "FORBIDDEN", message);
const notFound = (message = "The requested resource was not found") =>
  new HttpError(404, "NOT_FOUND", message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound };
