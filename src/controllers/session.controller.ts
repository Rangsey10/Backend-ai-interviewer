import { Request, Response, NextFunction } from 'express';
import { createSessionSchema, updateSessionStatusSchema } from '../validators/session.validator';
import { executeCodeSchema } from '../validators/codeRunner.validator';
import * as sessionService from '../services/session.service';
import * as codeRunnerService from '../services/codeRunner.service';
import { AppError } from '../middlewares/errorHandler';
import { JwtUserPayload, UserRole } from '../types/auth.types';
import { findAccountByEmail } from '../services/auth.service';

function requireUser(req: Request): JwtUserPayload {
  const user = req.user;
  if (!user) {
    throw new AppError('Authentication required', 401);
  }
  return user;
}

function requireSessionId(req: Request): string {
  const id = String(req.params.id || '');
  if (!id) {
    throw new AppError('Session ID is required', 400);
  }
  return id;
}

/**
 * POST /api/sessions/create
 * Recruiter or Candidate creates an interview room
 */
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const validatedData = createSessionSchema.parse(req.body);
    if (validatedData.candidateEmail && user.role !== UserRole.CANDIDATE) {
      const account = await findAccountByEmail(validatedData.candidateEmail);
      if (!account || account.role !== UserRole.CANDIDATE) {
        throw new AppError('No candidate account was found with that email', 404);
      }
      validatedData.candidateId = account.id;
    }
    const session = await sessionService.createSession(validatedData, user);

    res.status(201).json({
      success: true,
      message: 'Interview session room created successfully',
      data: session,
      session,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/sessions/:id
 * Fetch session details, candidate/recruiter info, and current code/state
 */
export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const session = await sessionService.getSessionForUser(requireSessionId(req), user);

    res.status(200).json({
      success: true,
      data: session,
      session,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /api/sessions/:id/status
 * Update session status (SCHEDULED, ACTIVE, COMPLETED)
 */
export async function updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = requireSessionId(req);
    await sessionService.getSessionForUser(id, user);

    const { status } = updateSessionStatusSchema.parse(req.body);
    const updatedSession = await sessionService.updateSessionStatus(id, status);

    res.status(200).json({
      success: true,
      message: `Session status updated to ${status}`,
      data: updatedSession,
      session: updatedSession,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/sessions/:id/execute-code
 * Executes untrusted candidate code in sandboxed runner and updates session codeState
 */
export async function executeCodeInSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = requireSessionId(req);
    await sessionService.getSessionForUser(id, user);

    const validatedInput = executeCodeSchema.parse(req.body);
    const result = await codeRunnerService.executeCodeForUser(user.userId, validatedInput);

    // Auto-update latest code in session
    await sessionService.updateSessionCode(id, validatedInput.code);

    res.status(200).json({
      success: true,
      message: 'Code executed in sandbox',
      result,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
