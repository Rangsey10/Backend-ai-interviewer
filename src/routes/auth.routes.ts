import { Router, Request, Response } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';
import { UserRole } from '../types/auth.types';
import { handle } from '../lib/handler';
import * as platform from '../controllers/platform.controller';

const router = Router();

// Public Authentication Endpoints
router.post('/register', authController.register);
router.post('/login', authController.login);

// Authenticated User Profile
router.get('/me', requireAuth, authController.getMe);
router.patch('/me', requireAuth, handle(platform.updateMyProfile));
router.post('/change-password', requireAuth, handle(platform.changeMyPassword));

// RBAC Demo / Role-guarded Endpoints
router.get('/candidate-only', requireAuth, requireRole([UserRole.CANDIDATE]), (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Access granted: Candidate resource',
    user: (req as any).user,
  });
});

router.get('/recruiter-only', requireAuth, requireRole([UserRole.RECRUITER, UserRole.ADMIN]), (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Access granted: Recruiter / Admin resource',
    user: (req as any).user,
  });
});

router.get('/admin-only', requireAuth, requireRole([UserRole.ADMIN]), (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Access granted: Admin restricted resource',
    user: (req as any).user,
  });
});

export default router;
