import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';
import { UserRole } from '../types/auth.types';

const router = Router();

/**
 * GET /api/test/me
 * Accessible by any authenticated user (CANDIDATE, RECRUITER, ADMIN)
 */
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Authenticated route accessed successfully',
    user: (req as any).user,
  });
});

/**
 * GET /api/test/admin-only
 * Accessible ONLY by users with the ADMIN role
 */
router.get('/admin-only', requireAuth, requireRole([UserRole.ADMIN]), (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Admin-only route accessed successfully',
    user: (req as any).user,
  });
});

export default router;
