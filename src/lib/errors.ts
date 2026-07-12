export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }

  static badRequest(msg: string, code = "BAD_REQUEST") {
    return new ApiError(400, code, msg);
  }
  static unauthorized(msg = "Authentication required", code = "UNAUTHORIZED") {
    return new ApiError(401, code, msg);
  }
  static forbidden(msg = "Not allowed", code = "FORBIDDEN") {
    return new ApiError(403, code, msg);
  }
  static notFound(msg = "Not found", code = "NOT_FOUND") {
    return new ApiError(404, code, msg);
  }
  static conflict(msg: string, code = "CONFLICT") {
    return new ApiError(409, code, msg);
  }
  static tooMany(msg: string, code = "RATE_LIMITED") {
    return new ApiError(429, code, msg);
  }
}
