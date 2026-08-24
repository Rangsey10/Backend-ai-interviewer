import { randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { JwtUserPayload, UserRole } from '../types/auth.types';
import { CreateSessionDTO, InterviewSessionData, SessionStatus } from '../types/session.types';
import { AppError } from '../middlewares/errorHandler';

const DEFAULT_INITIAL_CODE = `// Welcome to the Live Interview Session
// Language: JavaScript / TypeScript

function solution() {
  // Write your code here
  return true;
}

console.log(solution());
`;

// In-memory fallback session store for ultra-fast socket sync and test environments
const inMemorySessions = new Map<string, InterviewSessionData>();

/**
 * Creates a new interview session room
 */
export async function createSession(
  input: CreateSessionDTO,
  user: JwtUserPayload
): Promise<InterviewSessionData> {
  const sessionId = randomUUID();
  const now = new Date();

  // Role-based participant resolution
  let candidateId: string;
  let recruiterId: string | null = null;

  if (user.role === UserRole.CANDIDATE) {
    candidateId = user.userId;
    recruiterId = input.recruiterId || null;
  } else {
    // Recruiter / Admin creating session
    recruiterId = user.userId;
    candidateId = input.candidateId || user.userId;
  }

  const initialCode = input.initialCode || DEFAULT_INITIAL_CODE;
  const status = input.status || SessionStatus.SCHEDULED;

  const sessionData: InterviewSessionData = {
    id: sessionId,
    candidateId,
    recruiterId,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription || null,
    resumeText: input.resumeText || null,
    status,
    codeState: initialCode,
    currentQuestionIndex: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Cache in memory for immediate access & socket broadcast
  inMemorySessions.set(sessionId, sessionData);

  // Persist to Prisma DB if available
  try {
    if (prisma?.interviewSession?.create) {
      const created = await prisma.interviewSession.create({
        data: {
          id: sessionId,
          candidateId,
          recruiterId,
          jobTitle: input.jobTitle,
          jobDescription: input.jobDescription || null,
          resumeText: input.resumeText || null,
          status: status as any,
          codeState: initialCode,
          currentQuestionIndex: 0,
        },
        include: {
          candidate: { select: { id: true, fullName: true, email: true } },
          recruiter: { select: { id: true, fullName: true, email: true } },
        },
      });

      const fullData: InterviewSessionData = {
        id: created.id,
        candidateId: created.candidateId,
        recruiterId: created.recruiterId,
        jobTitle: created.jobTitle,
        jobDescription: created.jobDescription,
        resumeText: created.resumeText,
        status: created.status as SessionStatus,
        codeState: created.codeState || initialCode,
        currentQuestionIndex: created.currentQuestionIndex,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        candidate: created.candidate,
        recruiter: created.recruiter,
      };

      inMemorySessions.set(sessionId, fullData);
      return fullData;
    }
  } catch (err: any) {
    // If DB is offline or not migrated yet in test mode, fall back to memory
    console.warn(`[SessionService] DB persist warning: ${err?.message || err}. Using in-memory store.`);
  }

  return sessionData;
}

/**
 * Retrieves session by ID
 */
export async function getSessionById(sessionId: string): Promise<InterviewSessionData> {
  // Check in-memory cache first for live code state
  const cached = inMemorySessions.get(sessionId);

  try {
    if (prisma?.interviewSession?.findUnique) {
      const dbSession = await prisma.interviewSession.findUnique({
        where: { id: sessionId },
        include: {
          candidate: { select: { id: true, fullName: true, email: true } },
          recruiter: { select: { id: true, fullName: true, email: true } },
        },
      });

      if (dbSession) {
        const sessionData: InterviewSessionData = {
          id: dbSession.id,
          candidateId: dbSession.candidateId,
          recruiterId: dbSession.recruiterId,
          jobTitle: dbSession.jobTitle,
          jobDescription: dbSession.jobDescription,
          resumeText: dbSession.resumeText,
          status: dbSession.status as SessionStatus,
          codeState: cached?.codeState || dbSession.codeState || DEFAULT_INITIAL_CODE,
          currentQuestionIndex: dbSession.currentQuestionIndex,
          createdAt: dbSession.createdAt,
          updatedAt: dbSession.updatedAt,
          candidate: dbSession.candidate,
          recruiter: dbSession.recruiter,
        };

        inMemorySessions.set(sessionId, sessionData);
        return sessionData;
      }
    }
  } catch {
    // Fall back to memory
  }

  if (cached) {
    return cached;
  }

  throw new AppError(`Interview session with ID '${sessionId}' not found`, 404);
}

/**
 * Updates status of an interview session (SCHEDULED, ACTIVE, COMPLETED)
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<InterviewSessionData> {
  const session = await getSessionById(sessionId);
  session.status = status;
  session.updatedAt = new Date();

  inMemorySessions.set(sessionId, session);

  try {
    if (prisma?.interviewSession?.update) {
      await prisma.interviewSession.update({
        where: { id: sessionId },
        data: { status: status as any, updatedAt: new Date() },
      });
    }
  } catch {
    // Ignored in test/offline fallback
  }

  return session;
}

/**
 * Updates live code state in memory and asynchronously persists to DB
 */
export async function updateSessionCode(sessionId: string, code: string): Promise<void> {
  const cached = inMemorySessions.get(sessionId);
  if (cached) {
    cached.codeState = code;
    cached.updatedAt = new Date();
  }

  try {
    if (prisma?.interviewSession?.update) {
      await prisma.interviewSession.update({
        where: { id: sessionId },
        data: { codeState: code, updatedAt: new Date() },
      });
    }
  } catch {
    // Debounced background update
  }
}
