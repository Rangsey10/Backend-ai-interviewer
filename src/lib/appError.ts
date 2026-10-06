/**
 * Operational error with an HTTP status code. Kept free of third-party imports so that
 * pure modules (and their tests) can use it without pulling in express/zod.
 */
export class AppError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}
