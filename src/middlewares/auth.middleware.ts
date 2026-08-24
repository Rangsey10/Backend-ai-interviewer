import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtUserPayload, UserRole } from '../types/auth.types';

/**
 * Normalizes a role string to matching UserRole enum value or undefined
 */
export function normalizeRole(role?: string | null): UserRole | undefined {
  if (!role || typeof role !== 'string') {
    return undefined;
  }

  const upper = role.toUpperCase().trim();
  if (upper === UserRole.CANDIDATE || upper === UserRole.RECRUITER || upper === UserRole.ADMIN) {
    return upper as UserRole;
  }

  return undefined;
}

/**
 * Middleware that verifies JWT access token in the Authorization header
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        status: 401,
        message: 'Authentication required. Missing or malformed Bearer token.',
      });
      return;
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      res.status(401).json({
        success: false,
        status: 401,
        message: 'Authentication token cannot be empty.',
      });
      return;
    }

    let decoded: JwtUserPayload;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as JwtUserPayload;
    } catch (jwtError: any) {
      if (jwtError.name === 'TokenExpiredError') {
        res.status(401).json({
          success: false,
          status: 401,
          message: 'Authentication token has expired. Please log in again.',
        });
        return;
      }
      res.status(401).json({
        success: false,
        status: 401,
        message: 'Invalid authentication token.',
      });
      return;
    }

    const normalizedRole = normalizeRole(decoded.role);
    if (!normalizedRole) {
      res.status(403).json({
        success: false,
        status: 403,
        message: 'User role is invalid or not recognized.',
      });
      return;
    }

    (req as any).user = {
      ...decoded,
      role: normalizedRole,
    };
    (req as any).userRole = normalizedRole;

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Higher-order middleware to enforce Role-Based Access Control (RBAC)
 * Supports CANDIDATE, RECRUITER, ADMIN (case-insensitive)
 *
 * @example requireRole([UserRole.RECRUITER, UserRole.ADMIN])
 * @example requireRole(['ADMIN'])
 */
export const requireRole = (allowedRoles: (UserRole | string)[]) => {
  const normalizedAllowedRoles = allowedRoles
    .map((role) => normalizeRole(typeof role === 'string' ? role : String(role)))
    .filter((role): role is UserRole => role !== undefined);

  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    const userRole = (req as any).userRole;

    if (!user || !userRole) {
      res.status(401).json({
        success: false,
        status: 401,
        message: 'Unauthorized: User authentication required.',
      });
      return;
    }

    if (!normalizedAllowedRoles.includes(userRole)) {
      res.status(403).json({
        success: false,
        status: 403,
        message: `Forbidden: Access restricted to [${normalizedAllowedRoles.join(', ')}]. Current role: ${userRole}`,
      });
      return;
    }

    next();
  };
};
