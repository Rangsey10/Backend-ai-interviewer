import { Request, Response, NextFunction } from 'express';
import { createSessionSchema, updateSessionStatusSchema } from '../validators/session.validator';
import { executeCodeSchema } from '../validators/codeRunner.validator';
import * as sessionService from '../services/session.service';
import * as codeRunnerService from '../services/codeRunner.service';
import { AppError } from '../middlewares/errorHandler';

/**
 * POST /api/sessions/create
 * Recruiter or Candidate creates an interview room
 */
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = (req as any).user;
    if (!user) {
      throw new AppError('Authentication required to create an interview session', 401);
    }

    const validatedData = createSessionSchema.parse(req.body);
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
    const id = String(req.params.id || '');
    if (!id) {
      throw new AppError('Session ID is required', 400);
    }

    const session = await sessionService.getSessionById(id);

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
    const id = String(req.params.id || '');
    if (!id) {
      throw new AppError('Session ID is required', 400);
    }

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
    const id = String(req.params.id || '');
    if (!id) {
      throw new AppError('Session ID is required', 400);
    }

    // Verify session exists
    await sessionService.getSessionById(id);

    const validatedInput = executeCodeSchema.parse(req.body);

    // Run in isolated sandbox
    const result = await codeRunnerService.executeCode(validatedInput);

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
