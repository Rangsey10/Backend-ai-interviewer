import { AppError } from '../lib/appError';
import {
  aiMetrics, codingMetrics, compareCandidates, latestResultBySession, performanceSummary, sessionOverview,
  ComparisonInput, PerformancePoint,
} from '../lib/analytics';
import { average } from '../lib/scoring';
import { Db } from '../store/db';
import { Actor } from './interview.service';

export interface DashboardSession {
  id: string;
  candidateId: string;
  recruiterId?: string | null;
  jobTitle: string;
  status: string;
  createdAt: Date | string;
  candidate?: { id?: string; fullName: string; email?: string } | null;
}

export interface DashboardDeps {
  db: Db;
  /** Sessions the user is allowed to see (candidate: own; recruiter: assigned/unassigned; admin: all) */
  listSessions(user: Actor): Promise<DashboardSession[]>;
  /** Admin only: user counts by role/status */
  userStats(): Promise<{ total: number; byRole: Record<string, number>; pendingApproval: number }>;
  now?: () => Date;
}

export function createDashboardService(deps: DashboardDeps) {
  const { db } = deps;
  const now = () => (deps.now ? deps.now() : new Date());

  async function load(user: Actor) {
    const sessions = await deps.listSessions(user);
    const ids = sessions.map((s) => s.id);
    const [results, answers] = await Promise.all([db.listResults(ids), db.listAnswers(ids)]);
    return { sessions, results, answers };
  }

  /** Per-session performance numbers used by trends and comparisons */
  function perSession(sessions: DashboardSession[], results: Awaited<ReturnType<Db['listResults']>>, answers: Awaited<ReturnType<Db['listAnswers']>>) {
    const latest = latestResultBySession(results);
    return sessions.map((s) => {
      const mine = answers.filter((a) => a.sessionId === s.id);
      const result = latest.get(s.id) ?? null;
      return {
        session: s,
        result,
        theoryAverage: average(mine.filter((a) => a.question.type !== 'coding').map((a) => a.score)),
        codingAverage: average(mine.filter((a) => a.question.type === 'coding').map((a) => a.score)),
      };
    });
  }

  return {
    async candidate(user: Actor) {
      const { sessions, results, answers } = await load(user);
      const rows = perSession(sessions, results, answers);
      const points: PerformancePoint[] = rows
        .filter((r) => r.result)
        .map((r) => ({
          sessionId: r.session.id,
          jobTitle: r.session.jobTitle,
          date: r.result!.createdAt,
          overall: r.result!.score,
          theoryAverage: r.theoryAverage,
          codingAverage: r.codingAverage,
        }));
      const sorted = [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return {
        overview: sessionOverview(sessions, results, { now: now() }),
        performance: performanceSummary(points),
        upcoming: sorted.filter((s) => s.status !== 'COMPLETED').slice(0, 5),
        recent: sorted.filter((s) => s.status === 'COMPLETED').slice(0, 5),
      };
    },

    async recruiter(user: Actor) {
      const { sessions, results, answers } = await load(user);
      const rows = perSession(sessions, results, answers);
      return {
        overview: sessionOverview(sessions, results, { now: now() }),
        coding: codingMetrics(answers),
        candidates: rows
          .map((r) => ({
            sessionId: r.session.id,
            candidateName: r.session.candidate?.fullName ?? 'Candidate',
            jobTitle: r.session.jobTitle,
            status: r.session.status,
            overall: r.result?.score ?? null,
            recommendation: r.result?.recommendation ?? null,
            createdAt: r.session.createdAt,
          }))
          .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1)),
      };
    },

    async admin(user: Actor) {
      if (user.role !== 'ADMIN') throw new AppError('Admin access required', 403);
      const { sessions, results, answers } = await load(user);
      const since = new Date(now().getTime() - 7 * 24 * 3600 * 1000);
      return {
        overview: sessionOverview(sessions, results, { now: now() }),
        coding: codingMetrics(answers),
        users: await deps.userStats(),
        ai: aiMetrics(await db.listAiLogs(since)),
      };
    },

    /** Side-by-side ranking of candidates (recruiter/admin) */
    async compare(user: Actor, sessionIds: string[]) {
      if (user.role === 'CANDIDATE') throw new AppError('Only recruiters can compare candidates', 403);
      const unique = [...new Set(sessionIds)].slice(0, 10);
      if (unique.length < 2) throw new AppError('Provide at least two session ids to compare', 400);

      const { sessions, results, answers } = await load(user);
      const rows = perSession(sessions, results, answers);
      const picked = unique.map((id) => rows.find((r) => r.session.id === id));
      if (picked.some((p) => !p)) throw new AppError('One or more sessions were not found', 404);

      const items: ComparisonInput[] = picked.map((r) => ({
        sessionId: r!.session.id,
        candidateName: r!.session.candidate?.fullName ?? 'Candidate',
        jobTitle: r!.session.jobTitle,
        overall: r!.result?.score ?? null,
        theoryAverage: r!.theoryAverage,
        codingAverage: r!.codingAverage,
        recommendation: r!.result?.recommendation ?? null,
        strengths: (r!.result?.report?.strengths as string[]) ?? [],
        weaknesses: (r!.result?.report?.weaknesses as string[]) ?? [],
      }));
      return { candidates: compareCandidates(items) };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
