import { Router } from 'express';
import { handle } from '../lib/handler';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';
import { UserRole } from '../types/auth.types';
import * as c from '../controllers/platform.controller';

const recruiterOrAdmin = requireRole([UserRole.RECRUITER, UserRole.ADMIN]);
const adminOnly = requireRole([UserRole.ADMIN]);

/** AI gateway: identical paths to ai-service, so the frontend only changes its base URL */
export const aiRouter = Router();
aiRouter.use(requireAuth);
aiRouter.post('/questions', handle(c.aiQuestions('questions')));
aiRouter.post('/resume-questions', handle(c.aiQuestions('resume-questions')));
aiRouter.post('/job-description-questions', handle(c.aiQuestions('job-description-questions')));
aiRouter.post('/follow-up-questions', handle(c.aiFollowUp));
aiRouter.post('/feedback', handle(c.aiFeedback));
aiRouter.post('/final-report', handle(c.aiFinalReport));

export const submissionsRouter = Router();
submissionsRouter.use(requireAuth);
submissionsRouter.post('/execute', handle(c.executeSubmission));

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.get('/candidate', handle(c.candidateDashboard));
dashboardRouter.get('/recruiter', recruiterOrAdmin, handle(c.recruiterDashboard));
dashboardRouter.get('/admin', adminOnly, handle(c.adminDashboard));

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);
analyticsRouter.post('/compare', recruiterOrAdmin, handle(c.compareCandidates));
analyticsRouter.get('/ai', adminOnly, handle(c.aiHealth));

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', handle(c.listNotifications));
notificationsRouter.post('/read-all', handle(c.markAllNotificationsRead));
notificationsRouter.post('/:id/read', handle(c.markNotificationRead));

export const adminRouter = Router();
adminRouter.use(requireAuth, adminOnly);
adminRouter.get('/users', handle(c.adminListUsers));
adminRouter.patch('/users/:id', handle(c.adminUpdateUser));
