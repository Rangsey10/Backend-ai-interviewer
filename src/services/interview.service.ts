import { AppError } from '../lib/appError';
import { AiCallError, AiClient } from '../lib/aiClient';
import { average, codeScoreTo100, feedbackScoreTo100 } from '../lib/scoring';
import { Db, NewQuestion, QuestionRow } from '../store/db';

/**
 * AI gateway + interview persistence.
 *
 * The frontend talks to the backend using the same paths the AI service exposes
 * (/api/ai/*, /api/submissions/execute). The backend adds what the AI service lacks:
 * authentication, per-user rate limiting, session access control, persistence of
 * questions/answers/results, notifications and AI call monitoring.
 *
 * `sessionId` / `questionId` in a request body are OPTIONAL. Without them the call is a plain
 * pass-through (nothing stored); with them the result is saved against the interview.
 * `questionId` is the id the AI service gave the question (e.g. "q1").
 */

export type Actor = { userId: string; email: string; role: 'CANDIDATE' | 'RECRUITER' | 'ADMIN' | string };

export interface SessionLike {
  id: string;
  candidateId: string;
  recruiterId?: string | null;
  jobTitle: string;
  status: string;
  candidate?: { fullName: string } | null;
}

export interface InterviewDeps {
  ai: AiClient;
  db: Db;
  /** Access-checked session lookup (throws 404 when the user may not see it) */
  getSession(sessionId: string, user: Actor): Promise<SessionLike>;
  setSessionStatus(sessionId: string, status: 'COMPLETED' | 'ACTIVE' | 'SCHEDULED'): Promise<unknown>;
  limiter: { hit(key: string): { allowed: boolean; retryAfterSeconds: number } };
}

export type QuestionKind = 'questions' | 'resume-questions' | 'job-description-questions';

const TRACKING_KEYS = ['sessionId', 'questionId'] as const;

function split(body: any): { sessionId?: string; questionId?: string; payload: Record<string, any> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be a JSON object', 400);
  }
  const { sessionId, questionId, ...payload } = body;
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { sessionId: clean(sessionId), questionId: clean(questionId), payload };
}

/** Maps AI-style question objects ({id, question_text, type, topic, ...}) to rows; the AI's own id is kept in meta.aiId */
function toNewQuestions(list: any[], source: string): NewQuestion[] {
  return list.map((q, index) => {
    const { question_text, type, topic, difficulty, id, ...rest } = q ?? {};
    return {
      text: String(question_text ?? ''),
      type: type ?? null,
      topic: topic ?? null,
      difficulty: difficulty ?? null,
      order: index,
      meta: { ...rest, aiId: id ?? `q${index + 1}`, source },
    };
  });
}

export function createInterviewService(deps: InterviewDeps) {
  const { ai, db } = deps;

  /** Rate limit + call + log. Throws the AppError from the AI client on failure. */
  async function callAi<T>(feature: string, path: string, user: Actor, payload: unknown): Promise<T> {
    const gate = deps.limiter.hit(user.userId);
    if (!gate.allowed) {
      throw new AppError(`Too many AI requests. Please wait ${gate.retryAfterSeconds}s and try again.`, 429);
    }
    try {
      const result = await ai.post<T>(path, payload);
      await db.addAiLog({ feature, ok: true, latencyMs: result.latencyMs, attempts: result.attempts, error: null }).catch(() => {});
      return result.data;
    } catch (err: any) {
      const attempts = err instanceof AiCallError ? err.attempts : 1;
      const latencyMs = err instanceof AiCallError ? err.latencyMs : 0;
      await db.addAiLog({ feature, ok: false, latencyMs, attempts, error: String(err?.message ?? err).slice(0, 300) }).catch(() => {});
      throw err;
    }
  }

  /** Only the candidate of the session (or an admin) may submit answers for it */
  async function sessionForAnswering(sessionId: string, user: Actor): Promise<SessionLike> {
    const session = await deps.getSession(sessionId, user);
    if (user.role !== 'ADMIN' && session.candidateId !== user.userId) {
      throw new AppError('Only the interviewed candidate can submit answers for this session', 403);
    }
    return session;
  }

  async function resolveQuestion(sessionId: string, questionId: string): Promise<QuestionRow> {
    const questions = await db.listQuestions(sessionId);
    const found = questions.find((q) => q.meta?.aiId === questionId || q.id === questionId);
    if (!found) throw new AppError(`Question '${questionId}' was not found in this interview`, 404);
    return found;
  }

  async function notify(userId: string | null | undefined, type: string, title: string, body: string, data?: unknown) {
    if (!userId) return;
    await db.addNotification({ userId, type, title, body, data: data ?? null }).catch(() => {});
  }

  return {
    /* ------------------------------------------------------------ questions */
    async generateQuestions(user: Actor, kind: QuestionKind, body: any) {
      const { sessionId, payload } = split(body);
      if (sessionId) await deps.getSession(sessionId, user); // fail fast, before spending an AI call

      const data = await callAi<{ questions: any[] }>(`questions:${kind}`, `/api/ai/${kind}`, user, payload);

      if (sessionId && Array.isArray(data?.questions)) {
        await db.replaceQuestions(sessionId, toNewQuestions(data.questions, kind));
      }
      return data;
    },

    /* ------------------------------------------------------------- feedback */
    async feedback(user: Actor, body: any) {
      const { sessionId, questionId, payload } = split(body);
      let question: QuestionRow | null = null;
      if (sessionId && questionId) {
        await sessionForAnswering(sessionId, user);
        question = await resolveQuestion(sessionId, questionId);
      }
      const data = await callAi<any>('feedback', '/api/ai/feedback', user, payload);
      if (question) {
        await db.upsertAnswer(question.id, {
          answerText: String(payload.candidateAnswer ?? ''),
          feedback: data,
          score: feedbackScoreTo100(data?.score),
        });
      }
      return data;
    },

    async followUp(user: Actor, body: any) {
      const { sessionId, questionId, payload } = split(body);
      let question: QuestionRow | null = null;
      if (sessionId && questionId) {
        await sessionForAnswering(sessionId, user);
        question = await resolveQuestion(sessionId, questionId);
      }
      const data = await callAi<any>('follow-up', '/api/ai/follow-up-questions', user, payload);
      if (question) await db.upsertAnswer(question.id, { followUp: data });
      return data;
    },

    /* ----------------------------------------------------------------- code */
    async executeCode(user: Actor, body: any) {
      const { sessionId, questionId, payload } = split(body);
      let question: QuestionRow | null = null;
      if (sessionId && questionId) {
        await sessionForAnswering(sessionId, user);
        question = await resolveQuestion(sessionId, questionId);
      }
      const data = await callAi<any>('code-evaluation', '/api/submissions/execute', user, payload);
      if (question) {
        await db.upsertAnswer(question.id, {
          submittedCode: String(payload.candidateCode ?? ''),
          language: payload.programmingLanguage ?? null,
          codeEvaluation: data,
          score: codeScoreTo100(data?.score),
        });
      }
      return data;
    },

    /* --------------------------------------------------------- final report */
    /** Builds the AI-007 request from what is stored, so the frontend can send only a sessionId */
    async buildFinalReportInput(user: Actor, sessionId: string) {
      const session = await deps.getSession(sessionId, user);
      const [questions, answers] = await Promise.all([db.listQuestions(sessionId), db.listAnswers([sessionId])]);
      const byQuestion = new Map(answers.map((a) => [a.questionId, a]));

      const transcript = questions
        .map((q, i) => `Q${i + 1}: ${q.text}\nA${i + 1}: ${byQuestion.get(q.id)?.answerText || byQuestion.get(q.id)?.submittedCode || 'No answer'}`)
        .join('\n\n');

      return {
        candidateName: session.candidate?.fullName ?? 'Candidate',
        jobTitle: session.jobTitle,
        experienceLevel: 'Mid',
        interviewTranscript: transcript,
        perQuestionFeedback: answers
          .filter((a) => a.feedback)
          .map((a) => ({ score: a.feedback.score, missed_key_points: a.feedback.missed_key_points ?? [] })),
        codeEvaluations: answers
          .filter((a) => a.codeEvaluation)
          .map((a) => ({
            score: a.codeEvaluation.score,
            correctness: a.codeEvaluation.correctness,
            edge_cases_missed: a.codeEvaluation.edge_cases_missed ?? [],
          })),
      };
    },

    async finalReport(user: Actor, body: any) {
      const { sessionId, payload } = split(body);
      let request = payload;
      let session: SessionLike | null = null;

      if (sessionId) {
        session = await sessionForAnswering(sessionId, user);
        const stored = await this.buildFinalReportInput(user, sessionId);
        request = { ...stored, ...payload }; // anything the client sent explicitly wins
      }

      const data = await callAi<any>('final-report', '/api/ai/final-report', user, request);

      if (sessionId && session) {
        await db.addResult({
          sessionId,
          score: Number(data?.overall_score) || 0,
          feedback: String(data?.summary ?? ''),
          recommendation: data?.recommendation ?? null,
          report: data,
        });
        await deps.setSessionStatus(sessionId, 'COMPLETED');
        const who = data?.candidate_name || session.candidate?.fullName || 'The candidate';
        await notify(session.candidateId, 'FEEDBACK_READY', 'Your interview feedback is ready',
          `Your feedback for ${session.jobTitle} is available.`, { sessionId });
        await notify(session.recruiterId, 'INTERVIEW_COMPLETED', 'Interview completed',
          `${who} finished ${session.jobTitle} (score ${data?.overall_score ?? 'n/a'}).`, { sessionId });
      }
      return data;
    },

    /** Saves the (possibly hand-edited) question list for a session, e.g. when a recruiter finishes building an interview */
    async saveQuestions(user: Actor, sessionId: string, questions: unknown) {
      if (!Array.isArray(questions) || questions.length === 0 || questions.length > 50) {
        throw new AppError('Provide between 1 and 50 questions', 400);
      }
      for (const q of questions) {
        const text = (q as any)?.question_text;
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
          throw new AppError('Every question needs question_text (max 4000 characters)', 400);
        }
      }
      const session = await deps.getSession(sessionId, user);
      const saved = await db.replaceQuestions(sessionId, toNewQuestions(questions, 'manual'));
      await notify(session.candidateId === user.userId ? null : session.candidateId, 'INTERVIEW_SCHEDULED',
        'New interview assigned', `You have a new interview: ${session.jobTitle}.`, { sessionId });
      return saved;
    },

    /* --------------------------------------------------------------- reads */
    async listQuestions(user: Actor, sessionId: string) {
      await deps.getSession(sessionId, user);
      return db.listQuestions(sessionId);
    },

    /** Stored report + per-question breakdown. Candidates never see the hiring recommendation. */
    async getReport(user: Actor, sessionId: string) {
      const session = await deps.getSession(sessionId, user);
      const [questions, answers, results] = await Promise.all([
        db.listQuestions(sessionId),
        db.listAnswers([sessionId]),
        db.listResults([sessionId]),
      ]);
      const latest = [...results].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
      const byQuestion = new Map(answers.map((a) => [a.questionId, a]));

      let report = latest?.report ?? null;
      let recommendation = latest?.recommendation ?? null;
      if (user.role === 'CANDIDATE') {
        if (report) {
          const { recommendation: _r, recommendation_justification: _j, ...safe } = report;
          report = safe;
        }
        recommendation = null;
      }

      const breakdown = questions.map((q) => {
        const a = byQuestion.get(q.id);
        return {
          questionId: q.meta?.aiId ?? q.id,
          type: q.type,
          topic: q.topic,
          difficulty: q.difficulty,
          question: q.text,
          answer: a?.answerText ?? a?.submittedCode ?? null,
          feedback: a?.feedback ?? null,
          codeEvaluation: a?.codeEvaluation ?? null,
          score: a?.score ?? null,
        };
      });

      return {
        session: { id: session.id, jobTitle: session.jobTitle, status: session.status },
        overallScore: latest?.score ?? null,
        recommendation,
        report,
        questionAverage: average(breakdown.map((b) => b.score)),
        questions: breakdown,
      };
    },
  };
}

export type InterviewService = ReturnType<typeof createInterviewService>;
export { TRACKING_KEYS };
