import { env } from './config/env';
import { prisma } from './config/db';
import { createAiClient } from './lib/aiClient';
import { createRateLimiter } from './lib/rateLimiter';
import { createMemoryDb, createPrismaDb } from './store/db';
import { createInterviewService } from './services/interview.service';
import { createDashboardService } from './services/dashboard.service';
import { getSessionForUser, listSessionsForUser, updateSessionStatus } from './services/session.service';
import { userStats } from './services/auth.service';
import { JwtUserPayload } from './types/auth.types';
import { SessionStatus } from './types/session.types';

/** Wires the services to real infrastructure (Postgres or in-memory, the AI service, rate limits) */
export const db = prisma ? createPrismaDb(prisma) : createMemoryDb();

export const aiClient = createAiClient({
  baseUrl: env.AI_SERVICE_URL,
  timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  maxRetries: env.AI_MAX_RETRIES,
});

export const interviewService = createInterviewService({
  ai: aiClient,
  db,
  limiter: createRateLimiter(env.AI_RATE_LIMIT_PER_MINUTE),
  getSession: (sessionId, user) => getSessionForUser(sessionId, user as JwtUserPayload),
  setSessionStatus: (sessionId, status) => updateSessionStatus(sessionId, status as SessionStatus),
});

export const dashboardService = createDashboardService({
  db,
  listSessions: (user) => listSessionsForUser(user as JwtUserPayload),
  userStats,
});
