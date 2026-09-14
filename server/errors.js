export class AppError extends Error {
  constructor(message, { status = 500, code = "internal_error", cause } = {}) {
    super(message, { cause });
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function publicError(error) {
  if (error instanceof AppError) return error;

  if (error?.type === "entity.parse.failed") {
    return new AppError("The request body is not valid JSON.", {
      status: 400,
      code: "invalid_json",
      cause: error,
    });
  }
  if (error?.type === "entity.too.large") {
    return new AppError("The request body is too large.", {
      status: 413,
      code: "request_too_large",
      cause: error,
    });
  }

  const stripeCode = error?.code || error?.raw?.code;
  const stripeMessage = error?.raw?.message || error?.message;
  if (stripeCode || error?.type?.startsWith?.("Stripe")) {
    return new AppError(stripeMessage || "Stripe could not complete the request.", {
      status: error?.statusCode && error.statusCode < 500 ? error.statusCode : 502,
      code: stripeCode || "stripe_error",
      cause: error,
    });
  }

  return new AppError("The server could not complete the request.", {
    status: 500,
    code: "internal_error",
    cause: error,
  });
}
