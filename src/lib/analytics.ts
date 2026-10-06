import { average, percentile, recommendationRank, round1 } from './scoring';

/**
 * Pure aggregation functions behind the dashboards and the analytics endpoints.
 * They take plain rows (already loaded from the database) so they can be unit-tested.
 */

export interface SessionRow {
  id: string;
  candidateId: string;
  recruiterId?: string | null;
  jobTitle: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | string;
  createdAt: Date | string;
}

export interface ResultRow {
  sessionId: string;
  score: number;
  recommendation?: string | null;
  createdAt: Date | string;
}

export interface AnswerRow {
  sessionId: string;
  type?: string | null;
  score?: number | null;
  codeEvaluation?: any;
}

export interface AiLogRow {
  feature: string;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  error?: string | null;
  createdAt: Date | string;
}

const toDate = (d: Date | string) => (d instanceof Date ? d : new Date(d));
const dayKey = (d: Date | string) => toDate(d).toISOString().slice(0, 10);

/** One result per session: the most recent */
export function latestResultBySession<T extends ResultRow>(results: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const r of results) {
    const current = latest.get(r.sessionId);
    if (!current || toDate(r.createdAt) > toDate(current.createdAt)) latest.set(r.sessionId, r);
  }
  return latest;
}

export const SCORE_BUCKETS = ['0-19', '20-39', '40-59', '60-79', '80-100'] as const;

function bucketFor(score: number): (typeof SCORE_BUCKETS)[number] {
  if (score < 20) return '0-19';
  if (score < 40) return '20-39';
  if (score < 60) return '40-59';
  if (score < 80) return '60-79';
  return '80-100';
}

export interface Overview {
  totalSessions: number;
  byStatus: { SCHEDULED: number; ACTIVE: number; COMPLETED: number };
  completionRate: number; // % of sessions completed
  averageScore: number | null;
  scoreDistribution: Record<(typeof SCORE_BUCKETS)[number], number>;
  recommendationCounts: Record<string, number>;
  sessionsPerDay: Array<{ date: string; count: number }>;
}

export function sessionOverview(
  sessions: SessionRow[],
  results: ResultRow[],
  options: { now?: Date; days?: number } = {}
): Overview {
  const now = options.now ?? new Date();
  const days = options.days ?? 14;

  const byStatus = { SCHEDULED: 0, ACTIVE: 0, COMPLETED: 0 };
  for (const s of sessions) {
    if (s.status === 'SCHEDULED' || s.status === 'ACTIVE' || s.status === 'COMPLETED') byStatus[s.status] += 1;
  }

  const sessionIds = new Set(sessions.map((s) => s.id));
  const latest = [...latestResultBySession(results).values()].filter((r) => sessionIds.has(r.sessionId));

  const scoreDistribution = Object.fromEntries(SCORE_BUCKETS.map((b) => [b, 0])) as Overview['scoreDistribution'];
  const recommendationCounts: Record<string, number> = {};
  for (const r of latest) {
    scoreDistribution[bucketFor(r.score)] += 1;
    if (r.recommendation) recommendationCounts[r.recommendation] = (recommendationCounts[r.recommendation] ?? 0) + 1;
  }

  // Zero-filled daily series, oldest first, ending today (UTC)
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(dayKey(s.createdAt), (counts.get(dayKey(s.createdAt)) ?? 0) + 1);
  const sessionsPerDay: Overview['sessionsPerDay'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    sessionsPerDay.push({ date: key, count: counts.get(key) ?? 0 });
  }

  return {
    totalSessions: sessions.length,
    byStatus,
    completionRate: sessions.length ? round1((byStatus.COMPLETED / sessions.length) * 100) : 0,
    averageScore: average(latest.map((r) => r.score)),
    scoreDistribution,
    recommendationCounts,
    sessionsPerDay,
  };
}

export interface CodingMetrics {
  evaluatedSubmissions: number;
  averageScore: number | null;
  correctness: { pass: number; partial: number; fail: number };
  topMissedEdgeCases: Array<{ text: string; count: number }>;
}

export function codingMetrics(answers: AnswerRow[]): CodingMetrics {
  const evaluated = answers.filter((a) => a.codeEvaluation && typeof a.codeEvaluation === 'object');
  const correctness = { pass: 0, partial: 0, fail: 0 };
  const missed = new Map<string, { text: string; count: number }>();

  for (const a of evaluated) {
    const c = a.codeEvaluation.correctness;
    if (c === 'pass' || c === 'partial' || c === 'fail') correctness[c as 'pass' | 'partial' | 'fail'] += 1;
    const edges: unknown = a.codeEvaluation.edge_cases_missed;
    if (Array.isArray(edges)) {
      for (const raw of edges) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const key = raw.trim().toLowerCase();
        const entry = missed.get(key) ?? { text: raw.trim(), count: 0 };
        entry.count += 1;
        missed.set(key, entry);
      }
    }
  }

  return {
    evaluatedSubmissions: evaluated.length,
    averageScore: average(evaluated.map((a) => a.score ?? a.codeEvaluation.score)),
    correctness,
    topMissedEdgeCases: [...missed.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 5),
  };
}

export interface AiMetrics {
  totalCalls: number;
  failedCalls: number;
  successRate: number | null; // %
  retriedCalls: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  byFeature: Array<{ feature: string; calls: number; failures: number; averageLatencyMs: number | null }>;
  recentErrors: Array<{ feature: string; error: string; at: string }>;
}

export function aiMetrics(logs: AiLogRow[]): AiMetrics {
  const failed = logs.filter((l) => !l.ok);
  const latencies = logs.map((l) => l.latencyMs);

  const features = new Map<string, AiLogRow[]>();
  for (const l of logs) features.set(l.feature, [...(features.get(l.feature) ?? []), l]);

  return {
    totalCalls: logs.length,
    failedCalls: failed.length,
    successRate: logs.length ? round1(((logs.length - failed.length) / logs.length) * 100) : null,
    retriedCalls: logs.filter((l) => l.attempts > 1).length,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95LatencyMs: percentile(latencies, 95),
    byFeature: [...features.entries()]
      .map(([feature, rows]) => ({
        feature,
        calls: rows.length,
        failures: rows.filter((r) => !r.ok).length,
        averageLatencyMs: Math.round(rows.reduce((a, r) => a + r.latencyMs, 0) / rows.length),
      }))
      .sort((a, b) => b.calls - a.calls || a.feature.localeCompare(b.feature)),
    recentErrors: [...failed]
      .sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime())
      .slice(0, 5)
      .map((l) => ({ feature: l.feature, error: l.error ?? 'unknown error', at: toDate(l.createdAt).toISOString() })),
  };
}

export interface PerformancePoint {
  sessionId: string;
  jobTitle: string;
  date: Date | string;
  overall: number | null;
  theoryAverage: number | null;
  codingAverage: number | null;
}

export interface PerformanceSummary {
  completedInterviews: number;
  averageScore: number | null;
  bestScore: number | null;
  latestScore: number | null;
  /** latest vs. the average of earlier interviews: up / down / flat; null with fewer than 2 scored interviews */
  trend: 'up' | 'down' | 'flat' | null;
  series: PerformancePoint[];
}

export function performanceSummary(points: PerformancePoint[]): PerformanceSummary {
  const series = [...points].sort((a, b) => toDate(a.date).getTime() - toDate(b.date).getTime());
  const scored = series.filter((p) => p.overall !== null) as Array<PerformancePoint & { overall: number }>;

  let trend: PerformanceSummary['trend'] = null;
  if (scored.length >= 2) {
    const latest = scored[scored.length - 1].overall;
    const earlierAvg = average(scored.slice(0, -1).map((p) => p.overall))!;
    const diff = latest - earlierAvg;
    trend = diff > 2 ? 'up' : diff < -2 ? 'down' : 'flat';
  }

  return {
    completedInterviews: series.length,
    averageScore: average(scored.map((p) => p.overall)),
    bestScore: scored.length ? Math.max(...scored.map((p) => p.overall)) : null,
    latestScore: scored.length ? scored[scored.length - 1].overall : null,
    trend,
    series,
  };
}

export interface ComparisonInput {
  sessionId: string;
  candidateName: string;
  jobTitle: string;
  overall: number | null;
  theoryAverage: number | null;
  codingAverage: number | null;
  recommendation: string | null;
  strengths: string[];
  weaknesses: string[];
}

export interface ComparisonRow extends ComparisonInput {
  rank: number;
  deltaFromBest: number | null;
}

/** Ranks candidates: higher overall score first, ties broken by recommendation strength */
export function compareCandidates(items: ComparisonInput[]): ComparisonRow[] {
  const sorted = [...items].sort((a, b) => {
    const diff = (b.overall ?? -1) - (a.overall ?? -1);
    if (diff !== 0) return diff;
    return recommendationRank(b.recommendation) - recommendationRank(a.recommendation);
  });
  const best = sorted.length && sorted[0].overall !== null ? sorted[0].overall : null;
  return sorted.map((item, index) => ({
    ...item,
    rank: index + 1,
    deltaFromBest: best !== null && item.overall !== null ? round1(item.overall - best) : null,
  }));
}
