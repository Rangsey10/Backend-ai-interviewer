import { Request } from 'express';
import { AppError } from '../lib/appError';
import { currentUser } from '../lib/handler';
import { aiMetrics } from '../lib/analytics';
import { aiClient, dashboardService, db, interviewService } from '../container';
import * as authService from '../services/auth.service';
import * as sessionService from '../services/session.service';
import {
  adminUpdateUserSchema, changePasswordSchema, compareSchema, listUsersQuerySchema,
  notificationsQuerySchema, updateProfileSchema,
} from '../validators/platform.validator';
import { QuestionKind } from '../services/interview.service';
import { UserRole } from '../types/auth.types';

const actor = (req: Request) => currentUser(req);
const param = (req: Request, name: string) => {
  const v = String(req.params[name] ?? '');
  if (!v) throw new AppError(`${name} is required`, 400);
  return v;
};

/* ---- AI gateway (same paths as the AI service) ---- */
export const aiQuestions = (kind: QuestionKind) => (req: Request) => interviewService.generateQuestions(actor(req), kind, req.body);
export const aiFeedback = (req: Request) => interviewService.feedback(actor(req), req.body);
export const aiFollowUp = (req: Request) => interviewService.followUp(actor(req), req.body);
export const aiFinalReport = (req: Request) => interviewService.finalReport(actor(req), req.body);
export const executeSubmission = (req: Request) => interviewService.executeCode(actor(req), req.body);

/* ---- interviews ---- */
export const listSessions = (req: Request) => sessionService.listSessionsForUser(actor(req));
export const sessionQuestions = (req: Request) => interviewService.listQuestions(actor(req), param(req, 'id'));
export const saveSessionQuestions = (req: Request) =>
  interviewService.saveQuestions(actor(req), param(req, 'id'), req.body?.questions);
export const sessionReport = (req: Request) => interviewService.getReport(actor(req), param(req, 'id'));

/* ---- dashboards & analytics ---- */
export const candidateDashboard = (req: Request) => {
  if (actor(req).role !== UserRole.CANDIDATE && actor(req).role !== UserRole.ADMIN) throw new AppError('Candidates only', 403);
  return dashboardService.candidate(actor(req));
};
export const recruiterDashboard = (req: Request) => dashboardService.recruiter(actor(req));
export const adminDashboard = (req: Request) => dashboardService.admin(actor(req));
export const compareCandidates = (req: Request) =>
  dashboardService.compare(actor(req), compareSchema.parse(req.body).sessionIds);

/** AI reliability: calls, success rate, latency, retries, per-feature table (last 7 days) */
export async function aiHealth() {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  return {
    reachable: await aiClient.ping(),
    last7Days: aiMetrics(await db.listAiLogs(since)),
  };
}

/* ---- notifications ---- */
export async function listNotifications(req: Request) {
  const q = notificationsQuerySchema.parse(req.query);
  const userId = actor(req).userId;
  return {
    unread: await db.countUnread(userId),
    items: await db.listNotifications(userId, { unreadOnly: q.unreadOnly === 'true', limit: q.limit }),
  };
}
export async function markNotificationRead(req: Request) {
  const ok = await db.markNotificationRead(actor(req).userId, param(req, 'id'));
  if (!ok) throw new AppError('Notification not found', 404);
  return { read: true };
}
export async function markAllNotificationsRead(req: Request) {
  return { updated: await db.markAllNotificationsRead(actor(req).userId) };
}

/* ---- admin ---- */
export const adminListUsers = (req: Request) => authService.listUsers(listUsersQuerySchema.parse(req.query));

export async function adminUpdateUser(req: Request) {
  const changes = adminUpdateUserSchema.parse(req.body);
  const updated = await authService.adminUpdateUser(actor(req).userId, param(req, 'id'), changes as any);
  if (changes.status === 'ACTIVE' || changes.status === 'REJECTED') {
    await db
      .addNotification({
        userId: updated.id,
        type: 'ACCOUNT_STATUS',
        title: changes.status === 'ACTIVE' ? 'Your account was approved' : 'Your account request was declined',
        body: changes.status === 'ACTIVE' ? 'You can now sign in and use InterviewAI.' : 'Contact an administrator for details.',
        data: null,
      })
      .catch(() => {});
  }
  return updated;
}

/* ---- profile ---- */
export const updateMyProfile = (req: Request) => authService.updateProfile(actor(req).userId, updateProfileSchema.parse(req.body));
export async function changeMyPassword(req: Request) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  await authService.changePassword(actor(req).userId, currentPassword, newPassword);
  return { changed: true };
}
