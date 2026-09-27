import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const formattedErrors = err.issues.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    res.status(400).json({
      success: false,
      status: 400,
      message: 'Validation failed',
      errors: formattedErrors,
    });
    return;
  }

  // Handle Prisma unique constraint violation (P2002)
  if (err.code === 'P2002') {
    res.status(409).json({
      success: false,
      status: 409,
      message: 'A record with this information already exists',
    });
    return;
  }

  const statusCode = err instanceof AppError ? err.statusCode : err.status || 500;

  // Unexpected errors (DB, bugs) may carry internal details — log them, don't expose in production
  if (!(err instanceof AppError) && statusCode >= 500) {
    console.error('[Error]', err);
  }
  const message =
    statusCode >= 500 && !(err instanceof AppError) && process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    status: statusCode,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
