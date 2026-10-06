import { randomUUID } from 'crypto';

/**
 * Narrow data-access layer for everything the AI/dashboard features persist
 * (questions, answers, results, notifications, AI call logs).
 *
 * Two implementations behind one interface:
 *   - createPrismaDb(prisma)  → PostgreSQL (used when DATABASE_URL is set)
 *   - createMemoryDb()        → in-memory (dev without a database, and the unit tests)
 * Users and sessions keep living in auth.service / session.service as before.
 */

export interface QuestionRow {
  id: string;
  sessionId: string;
  text: string;
  type: string | null;
  topic: string | null;
  difficulty: string | null;
  order: number;
  meta: Record<string, any> | null;
}
export type NewQuestion = Omit<QuestionRow, 'id' | 'sessionId'>;

export interface AnswerRecord {
  id: string;
  questionId: string;
  answerText: string | null;
  submittedCode: string | null;
  language: string | null;
  feedback: any | null;
  codeEvaluation: any | null;
  followUp: any | null;
  score: number | null;
  createdAt: Date;
}
export type AnswerPatch = Partial<Omit<AnswerRecord, 'id' | 'questionId' | 'createdAt'>>;
/** An answer joined with its question (what analytics and reports need) */
export interface AnswerWithQuestion extends AnswerRecord {
  sessionId: string;
  question: QuestionRow;
}

export interface ResultRecord {
  id: string;
  sessionId: string;
  score: number;
  feedback: string;
  recommendation: string | null;
  report: any | null;
  createdAt: Date;
}
export type NewResult = Omit<ResultRecord, 'id' | 'createdAt'>;

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  data: any | null;
  read: boolean;
  createdAt: Date;
}
export type NewNotification = Omit<NotificationRecord, 'id' | 'createdAt' | 'read'>;

export interface AiLogRecord {
  id: string;
  feature: string;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  error: string | null;
  createdAt: Date;
}
export type NewAiLog = Omit<AiLogRecord, 'id' | 'createdAt'>;

export interface Db {
  replaceQuestions(sessionId: string, questions: NewQuestion[]): Promise<QuestionRow[]>;
  listQuestions(sessionId: string): Promise<QuestionRow[]>;

  upsertAnswer(questionId: string, patch: AnswerPatch): Promise<AnswerRecord>;
  listAnswers(sessionIds: string[]): Promise<AnswerWithQuestion[]>;

  addResult(result: NewResult): Promise<ResultRecord>;
  listResults(sessionIds: string[]): Promise<ResultRecord[]>;

  addNotification(n: NewNotification): Promise<NotificationRecord>;
  listNotifications(userId: string, opts?: { unreadOnly?: boolean; limit?: number }): Promise<NotificationRecord[]>;
  countUnread(userId: string): Promise<number>;
  markNotificationRead(userId: string, id: string): Promise<boolean>;
  markAllNotificationsRead(userId: string): Promise<number>;

  addAiLog(log: NewAiLog): Promise<void>;
  listAiLogs(since: Date): Promise<AiLogRecord[]>;
}

/* ------------------------------------------------------------------ memory */

export function createMemoryDb(): Db {
  const questions = new Map<string, QuestionRow>();
  const answers = new Map<string, AnswerRecord>(); // by questionId
  const results: ResultRecord[] = [];
  const notifications: NotificationRecord[] = [];
  const aiLogs: AiLogRecord[] = [];

  const sessionQuestions = (sessionId: string) =>
    [...questions.values()].filter((q) => q.sessionId === sessionId).sort((a, b) => a.order - b.order);

  return {
    async replaceQuestions(sessionId, list) {
      for (const q of sessionQuestions(sessionId)) {
        questions.delete(q.id);
        answers.delete(q.id); // answers belong to their question (cascade)
      }
      const created = list.map((q) => ({ ...q, id: randomUUID(), sessionId }));
      created.forEach((q) => questions.set(q.id, q));
      return created;
    },
    async listQuestions(sessionId) {
      return sessionQuestions(sessionId);
    },

    async upsertAnswer(questionId, patch) {
      if (!questions.has(questionId)) throw new Error(`Question ${questionId} does not exist`);
      const existing = answers.get(questionId) ?? {
        id: randomUUID(),
        questionId,
        answerText: null,
        submittedCode: null,
        language: null,
        feedback: null,
        codeEvaluation: null,
        followUp: null,
        score: null,
        createdAt: new Date(),
      };
      const next = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (next as any)[key] = value;
      }
      answers.set(questionId, next);
      return next;
    },
    async listAnswers(sessionIds) {
      const wanted = new Set(sessionIds);
      const out: AnswerWithQuestion[] = [];
      for (const a of answers.values()) {
        const q = questions.get(a.questionId);
        if (q && wanted.has(q.sessionId)) out.push({ ...a, sessionId: q.sessionId, question: q });
      }
      return out;
    },

    async addResult(r) {
      const row: ResultRecord = { ...r, id: randomUUID(), createdAt: new Date() };
      results.push(row);
      return row;
    },
    async listResults(sessionIds) {
      const wanted = new Set(sessionIds);
      return results.filter((r) => wanted.has(r.sessionId));
    },

    async addNotification(n) {
      const row: NotificationRecord = { ...n, id: randomUUID(), read: false, createdAt: new Date() };
      notifications.push(row);
      return row;
    },
    async listNotifications(userId, opts = {}) {
      return notifications
        .filter((n) => n.userId === userId && (!opts.unreadOnly || !n.read))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, opts.limit ?? 50);
    },
    async countUnread(userId) {
      return notifications.filter((n) => n.userId === userId && !n.read).length;
    },
    async markNotificationRead(userId, id) {
      const n = notifications.find((x) => x.id === id && x.userId === userId);
      if (!n) return false;
      n.read = true;
      return true;
    },
    async markAllNotificationsRead(userId) {
      let count = 0;
      for (const n of notifications) {
        if (n.userId === userId && !n.read) {
          n.read = true;
          count += 1;
        }
      }
      return count;
    },

    async addAiLog(log) {
      aiLogs.push({ ...log, id: randomUUID(), createdAt: new Date() });
    },
    async listAiLogs(since) {
      return aiLogs.filter((l) => l.createdAt >= since);
    },
  };
}

/* ------------------------------------------------------------------ prisma */

/** `prisma` is typed loosely on purpose: the generated client only exists after `prisma generate`. */
export function createPrismaDb(prisma: any): Db {
  return {
    async replaceQuestions(sessionId, list) {
      await prisma.$transaction([
        prisma.question.deleteMany({ where: { sessionId } }),
        prisma.question.createMany({ data: list.map((q) => ({ ...q, sessionId, meta: q.meta ?? undefined })) }),
      ]);
      return prisma.question.findMany({ where: { sessionId }, orderBy: { order: 'asc' } });
    },
    listQuestions(sessionId) {
      return prisma.question.findMany({ where: { sessionId }, orderBy: { order: 'asc' } });
    },

    upsertAnswer(questionId, patch) {
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) data[key] = value;
      return prisma.answer.upsert({ where: { questionId }, create: { questionId, ...data }, update: data });
    },
    async listAnswers(sessionIds) {
      if (sessionIds.length === 0) return [];
      const rows = await prisma.answer.findMany({
        where: { question: { sessionId: { in: sessionIds } } },
        include: { question: true },
      });
      return rows.map((r: any) => ({ ...r, sessionId: r.question.sessionId }));
    },

    addResult(r) {
      return prisma.result.create({ data: { ...r, report: r.report ?? undefined } });
    },
    listResults(sessionIds) {
      if (sessionIds.length === 0) return Promise.resolve([]);
      return prisma.result.findMany({ where: { sessionId: { in: sessionIds } }, orderBy: { createdAt: 'asc' } });
    },

    addNotification(n) {
      return prisma.notification.create({ data: { ...n, data: n.data ?? undefined } });
    },
    listNotifications(userId, opts = {}) {
      return prisma.notification.findMany({
        where: { userId, ...(opts.unreadOnly ? { read: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 50,
      });
    },
    countUnread(userId) {
      return prisma.notification.count({ where: { userId, read: false } });
    },
    async markNotificationRead(userId, id) {
      const res = await prisma.notification.updateMany({ where: { id, userId }, data: { read: true } });
      return res.count > 0;
    },
    async markAllNotificationsRead(userId) {
      const res = await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
      return res.count;
    },

    async addAiLog(log) {
      await prisma.aiCallLog.create({ data: log });
    },
    listAiLogs(since) {
      return prisma.aiCallLog.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 5000 });
    },
  };
}
