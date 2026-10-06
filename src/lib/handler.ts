import { Request, RequestHandler } from 'express';
import { AppError } from './appError';
import { JwtUserPayload } from '../types/auth.types';

/** The authenticated user (requireAuth must run first) */
export function currentUser(req: Request): JwtUserPayload {
  const user = (req as any).user as JwtUserPayload | undefined;
  if (!user) throw new AppError('Authentication required', 401);
  return user;
}

/**
 * Wraps an async controller: its return value is sent as `{ success: true, data }`,
 * and any thrown error goes to the global error handler.
 */
export function handle(fn: (req: Request) => Promise<unknown>, status = 200): RequestHandler {
  return async (req, res, next) => {
    try {
      const data = await fn(req);
      res.status(status).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}
