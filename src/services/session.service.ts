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

const PARTICIPANT_SELECT = { select: { id: true, fullName: true, email: true } } as const;

// In-memory session store, used ONLY when no DATABASE_URL is configured (dev/test)
const inMemorySessions = new Map<string, InterviewSessionData>();

// Latest live code per session. Socket edits are persisted with a debounce, so this
// lets someone joining mid-edit see the newest code rather than the last saved copy.
const liveCodeCache = new Map<string, string>();

function toSessionData(row: any): InterviewSessionData {
  return {
    id: row.id,
    candidateId: row.candidateId,
    recruiterId: row.recruiterId,
    jobTitle: row.jobTitle,
    jobDescription: row.jobDescription,
    resumeText: row.resumeText,
    status: row.status as SessionStatus,
    codeState: liveCodeCache.get(row.id) ?? row.codeState ?? DEFAULT_INITIAL_CODE,
    currentQuestionIndex: row.currentQuestionIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    candidate: row.candidate,
    recruiter: row.recruiter,
  };
}

/**
 * Who may see / act on a session:
 *   - ADMIN: any session
 *   - CANDIDATE: only sessions where they are the candidate
 *   - RECRUITER: sessions assigned to them, or not yet assigned to any recruiter
 */
export function canAccessSession(session: InterviewSessionData, user: JwtUserPayload): boolean {
  switch (user.role) {
    case UserRole.ADMIN:
      return true;
    case UserRole.CANDIDATE:
      return session.candidateId === user.userId;
    case UserRole.RECRUITER:
      return !session.recruiterId || session.recruiterId === user.userId;
    default:
      return false;
  }
}

/**
 * Creates a new interview session room
 */
export async function createSession(
  input: CreateSessionDTO,
  user: JwtUserPayload
): Promise<InterviewSessionData> {
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

  const data = {
    candidateId,
    recruiterId,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription || null,
    resumeText: input.resumeText || null,
    status: input.status || SessionStatus.SCHEDULED,
    codeState: input.initialCode || DEFAULT_INITIAL_CODE,
    currentQuestionIndex: 0,
  };

  if (prisma) {
    const created = await prisma.interviewSession.create({
      data,
      include: { candidate: PARTICIPANT_SELECT, recruiter: PARTICIPANT_SELECT },
    });
    return toSessionData(created);
  }

  const now = new Date();
  const session: InterviewSessionData = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
  inMemorySessions.set(session.id, session);
  return session;
}

/**
 * Retrieves session by ID (no access check — use getSessionForUser for user-facing reads)
 */
export async function getSessionById(sessionId: string): Promise<InterviewSessionData> {
  if (prisma) {
    const row = await prisma.interviewSession.findUnique({
      where: { id: sessionId },
      include: { candidate: PARTICIPANT_SELECT, recruiter: PARTICIPANT_SELECT },
    });
    if (row) return toSessionData(row);
  } else {
    const cached = inMemorySessions.get(sessionId);
    if (cached) return cached;
  }

  throw new AppError(`Interview session with ID '${sessionId}' not found`, 404);
}

/**
 * Retrieves a session only if the user is allowed to access it.
 * Unauthorized access is reported as "not found" so session IDs can't be probed.
 */
export async function getSessionForUser(sessionId: string, user: JwtUserPayload): Promise<InterviewSessionData> {
  const session = await getSessionById(sessionId);
  if (!canAccessSession(session, user)) {
    throw new AppError(`Interview session with ID '${sessionId}' not found`, 404);
  }
  return session;
}

/**
 * Updates status of an interview session (SCHEDULED, ACTIVE, COMPLETED)
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<InterviewSessionData> {
  if (prisma) {
    const row = await prisma.interviewSession.update({
      where: { id: sessionId },
      data: { status },
      include: { candidate: PARTICIPANT_SELECT, recruiter: PARTICIPANT_SELECT },
    });
    return toSessionData(row);
  }

  const session = await getSessionById(sessionId);
  session.status = status;
  session.updatedAt = new Date();
  return session;
}

/**
 * Records the latest live code for a session (memory immediately, DB when configured)
 */
export async function updateSessionCode(sessionId: string, code: string): Promise<void> {
  liveCodeCache.set(sessionId, code);

  if (prisma) {
    await prisma.interviewSession.update({
      where: { id: sessionId },
      data: { codeState: code },
    });
    // DB is now current unless a newer edit arrived while saving
    if (liveCodeCache.get(sessionId) === code) {
      liveCodeCache.delete(sessionId);
    }
    return;
  }

  const cached = inMemorySessions.get(sessionId);
  if (cached) {
    cached.codeState = code;
    cached.updatedAt = new Date();
  }
}
