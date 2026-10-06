import { Request, Response, NextFunction } from 'express';
import { registerSchema, loginSchema } from '../validators/auth.validator';
import * as authService from '../services/auth.service';

/**
 * POST /api/auth/register
 * Handles user registration with validation, password hashing, and token issuance
 */
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const validatedData = registerSchema.parse(req.body);
    const result = await authService.register(validatedData);

    res.status(201).json({
      success: true,
      message: result.pendingApproval
        ? 'Registration received. An administrator must approve your recruiter account before you can sign in.'
        : 'User registered successfully',
      user: result.user,
      token: result.token,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/login
 * Handles user login with password verification and JWT token return
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const validatedData = loginSchema.parse(req.body);
    const result = await authService.login(validatedData);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      user: result.user,
      token: result.token,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/me
 * Retrieves current authenticated user profile
 */
export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({
        success: false,
        status: 401,
        message: 'Unauthorized: User not authenticated',
      });
      return;
    }

    const profile = await authService.getUserProfile(userId);

    res.status(200).json({
      success: true,
      user: profile,
      data: profile,
    });
  } catch (error) {
    next(error);
  }
}
