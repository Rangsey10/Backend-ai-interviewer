import { test } from 'node:test';
import assert from 'node:assert/strict';
import { average, codeScoreTo100, feedbackScoreTo100, percentile, recommendationRank, scoreForAnswer } from '../src/lib/scoring';
import { createRateLimiter } from '../src/lib/rateLimiter';
import { aiMetrics, codingMetrics, compareCandidates, performanceSummary, sessionOverview } from '../src/lib/analytics';

test('score scales: feedback is 0-10, code is 0-100, both clamp and reject junk', () => {
  assert.equal(feedbackScoreTo100(7), 70);
  assert.equal(feedbackScoreTo100(11), 100);
  assert.equal(feedbackScoreTo100(-3), 0);
  assert.equal(feedbackScoreTo100('abc'), null);
  assert.equal(codeScoreTo100(78), 78);
  assert.equal(codeScoreTo100(140), 100);
  assert.equal(codeScoreTo100(undefined), null);
});

test('scoreForAnswer prefers the code evaluation, falls back to feedback, else null', () => {
  assert.equal(scoreForAnswer({ codeEvaluation: { score: 55 }, feedback: { score: 9 } }), 55);
  assert.equal(scoreForAnswer({ feedback: { score: 8 } }), 80);
  assert.equal(scoreForAnswer({}), null);
});

test('average ignores nulls; percentile uses nearest rank', () => {
  assert.equal(average([80, null, 60, undefined]), 70);
  assert.equal(average([]), null);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50), 50);
  assert.equal(percentile([], 95), null);
});

test('recommendationRank orders the five recommendations', () => {
  assert.ok(recommendationRank('Strong Hire') > recommendationRank('Hire'));
  assert.ok(recommendationRank('Hire') > recommendationRank('Lean Hire'));
  assert.ok(recommendationRank('No Hire') > recommendationRank('Strong No Hire'));
  assert.equal(recommendationRank('???'), 0);
  assert.equal(recommendationRank(null), 0);
});

test('rate limiter: allows up to the limit, blocks, then frees slots as the window slides', () => {
  let t = 1_000_000;
  const limiter = createRateLimiter(3, 60_000, () => t);
  assert.equal(limiter.hit('u1').allowed, true);
  t += 1000;
  assert.equal(limiter.hit('u1').allowed, true);
  t += 1000;
  assert.equal(limiter.hit('u1').allowed, true);
  t += 1000;
  const blocked = limiter.hit('u1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 57); // first hit at t0 frees at t0+60s; now t0+3s
  assert.equal(limiter.hit('u2').allowed, true, 'other users are unaffected');
  t += 58_000; // first hit has aged out
  assert.equal(limiter.hit('u1').allowed, true);
});

const NOW = new Date('2026-10-06T12:00:00Z');

test('sessionOverview: counts, completion rate, average of LATEST result per session, buckets, zero-filled days', () => {
  const sessions = [
    { id: 's1', candidateId: 'c1', jobTitle: 'A', status: 'COMPLETED', createdAt: '2026-10-06T08:00:00Z' },
    { id: 's2', candidateId: 'c2', jobTitle: 'A', status: 'COMPLETED', createdAt: '2026-10-05T08:00:00Z' },
    { id: 's3', candidateId: 'c3', jobTitle: 'B', status: 'ACTIVE', createdAt: '2026-10-05T09:00:00Z' },
    { id: 's4', candidateId: 'c4', jobTitle: 'B', status: 'SCHEDULED', createdAt: '2026-09-01T09:00:00Z' },
  ];
  const results = [
    { sessionId: 's1', score: 40, recommendation: 'No Hire', createdAt: '2026-10-06T09:00:00Z' },
    { sessionId: 's1', score: 90, recommendation: 'Strong Hire', createdAt: '2026-10-06T10:00:00Z' }, // regenerated, newer
    { sessionId: 's2', score: 70, recommendation: 'Hire', createdAt: '2026-10-05T10:00:00Z' },
    { sessionId: 'ghost', score: 10, recommendation: 'No Hire', createdAt: '2026-10-05T10:00:00Z' }, // not in scope
  ];
  const o = sessionOverview(sessions, results, { now: NOW, days: 3 });
  assert.equal(o.totalSessions, 4);
  assert.deepEqual(o.byStatus, { SCHEDULED: 1, ACTIVE: 1, COMPLETED: 2 });
  assert.equal(o.completionRate, 50);
  assert.equal(o.averageScore, 80); // (90 + 70) / 2, not counting the superseded 40 or the out-of-scope 10
  assert.equal(o.scoreDistribution['80-100'], 1);
  assert.equal(o.scoreDistribution['60-79'], 1);
  assert.equal(o.scoreDistribution['0-19'], 0);
  assert.deepEqual(o.recommendationCounts, { 'Strong Hire': 1, Hire: 1 });
  assert.deepEqual(o.sessionsPerDay, [
    { date: '2026-10-04', count: 0 },
    { date: '2026-10-05', count: 2 },
    { date: '2026-10-06', count: 1 },
  ]);
});

test('sessionOverview on no data is all zeros / null, never NaN', () => {
  const o = sessionOverview([], [], { now: NOW, days: 2 });
  assert.equal(o.completionRate, 0);
  assert.equal(o.averageScore, null);
  assert.equal(o.totalSessions, 0);
});

test('codingMetrics: correctness counts, average, and most-missed edge cases (case-insensitive)', () => {
  const m = codingMetrics([
    { sessionId: 's1', score: 90, codeEvaluation: { score: 90, correctness: 'pass', edge_cases_missed: [] } },
    { sessionId: 's2', score: 50, codeEvaluation: { score: 50, correctness: 'partial', edge_cases_missed: ['Empty string', 'null input'] } },
    { sessionId: 's3', score: 10, codeEvaluation: { score: 10, correctness: 'fail', edge_cases_missed: ['empty string'] } },
    { sessionId: 's4', score: 70 }, // theory answer, no code evaluation
  ]);
  assert.equal(m.evaluatedSubmissions, 3);
  assert.equal(m.averageScore, 50);
  assert.deepEqual(m.correctness, { pass: 1, partial: 1, fail: 1 });
  assert.deepEqual(m.topMissedEdgeCases[0], { text: 'Empty string', count: 2 });
  assert.equal(m.topMissedEdgeCases.length, 2);
});

test('aiMetrics: success rate, retries, latency percentile, per-feature table, recent errors', () => {
  const at = (m: number) => `2026-10-06T10:0${m}:00Z`;
  const m = aiMetrics([
    { feature: 'feedback', ok: true, latencyMs: 1000, attempts: 1, createdAt: at(1) },
    { feature: 'feedback', ok: true, latencyMs: 2000, attempts: 2, createdAt: at(2) },
    { feature: 'feedback', ok: false, latencyMs: 3000, attempts: 1, error: 'rate limited', createdAt: at(3) },
    { feature: 'final-report', ok: true, latencyMs: 4000, attempts: 1, createdAt: at(4) },
  ]);
  assert.equal(m.totalCalls, 4);
  assert.equal(m.failedCalls, 1);
  assert.equal(m.successRate, 75);
  assert.equal(m.retriedCalls, 1);
  assert.equal(m.averageLatencyMs, 2500);
  assert.equal(m.p95LatencyMs, 4000);
  assert.deepEqual(m.byFeature[0], { feature: 'feedback', calls: 3, failures: 1, averageLatencyMs: 2000 });
  assert.equal(m.recentErrors[0].error, 'rate limited');
  assert.equal(aiMetrics([]).successRate, null);
});

test('performanceSummary: trend compares the latest interview to the average of the earlier ones', () => {
  const pt = (id: string, date: string, overall: number | null) => ({
    sessionId: id, jobTitle: 'Dev', date, overall, theoryAverage: null, codingAverage: null,
  });
  const up = performanceSummary([pt('b', '2026-10-02', 80), pt('a', '2026-10-01', 60), pt('c', '2026-10-03', 90)]);
  assert.deepEqual(up.series.map((p) => p.sessionId), ['a', 'b', 'c'], 'sorted oldest first');
  assert.equal(up.latestScore, 90);
  assert.equal(up.bestScore, 90);
  assert.equal(up.averageScore, 76.7);
  assert.equal(up.trend, 'up'); // 90 vs avg(60,80)=70
  assert.equal(performanceSummary([pt('a', '2026-10-01', 70), pt('b', '2026-10-02', 71)]).trend, 'flat');
  assert.equal(performanceSummary([pt('a', '2026-10-01', 80), pt('b', '2026-10-02', 50)]).trend, 'down');
  assert.equal(performanceSummary([pt('a', '2026-10-01', 80)]).trend, null);
  assert.equal(performanceSummary([]).averageScore, null);
});

test('compareCandidates: ranked by score, ties by recommendation, with delta from the best', () => {
  const c = (id: string, overall: number | null, recommendation: string | null) => ({
    sessionId: id, candidateName: id, jobTitle: 'Dev', overall, theoryAverage: null, codingAverage: null,
    recommendation, strengths: [], weaknesses: [],
  });
  const rows = compareCandidates([c('low', 55, 'Lean Hire'), c('tieB', 80, 'Hire'), c('top', 92, 'Strong Hire'), c('tieA', 80, 'Strong Hire'), c('none', null, null)]);
  assert.deepEqual(rows.map((r) => r.sessionId), ['top', 'tieA', 'tieB', 'low', 'none']);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(rows[1].deltaFromBest, -12);
  assert.equal(rows[4].deltaFromBest, null);
});
