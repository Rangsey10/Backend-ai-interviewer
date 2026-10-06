import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../src/store/db';
import { createDashboardService, DashboardSession } from '../src/services/dashboard.service';

const NOW = new Date('2026-10-06T12:00:00Z');
const sessions: DashboardSession[] = [
  { id: 's1', candidateId: 'c1', recruiterId: 'r1', jobTitle: 'Backend', status: 'COMPLETED', createdAt: '2026-10-05T08:00:00Z', candidate: { fullName: 'Ann' } },
  { id: 's2', candidateId: 'c2', recruiterId: 'r1', jobTitle: 'Backend', status: 'COMPLETED', createdAt: '2026-10-05T09:00:00Z', candidate: { fullName: 'Bob' } },
  { id: 's3', candidateId: 'c1', recruiterId: null, jobTitle: 'Frontend', status: 'SCHEDULED', createdAt: '2026-10-06T09:00:00Z', candidate: { fullName: 'Ann' } },
];

async function seed() {
  const db = createMemoryDb();
  for (const sid of ['s1', 's2']) {
    const [theory, coding] = await db.replaceQuestions(sid, [
      { text: 'T', type: 'theoretical', topic: null, difficulty: null, order: 0, meta: null },
      { text: 'C', type: 'coding', topic: null, difficulty: null, order: 1, meta: null },
    ]);
    await db.upsertAnswer(theory.id, { score: sid === 's1' ? 90 : 60, feedback: { score: 9 } });
    await db.upsertAnswer(coding.id, { score: sid === 's1' ? 80 : 30, codeEvaluation: { score: 80, correctness: sid === 's1' ? 'pass' : 'fail', edge_cases_missed: ['empty'] } });
  }
  await db.addResult({ sessionId: 's1', score: 85, feedback: 'f', recommendation: 'Hire', report: { strengths: ['a'], weaknesses: ['b'] } });
  await db.addResult({ sessionId: 's2', score: 45, feedback: 'f', recommendation: 'No Hire', report: null });
  await db.addAiLog({ feature: 'feedback', ok: true, latencyMs: 1000, attempts: 1, error: null });
  const svc = createDashboardService({
    db, now: () => NOW,
    async listSessions(user) {
      if (user.role === 'ADMIN') return sessions;
      if (user.role === 'CANDIDATE') return sessions.filter((s) => s.candidateId === user.userId);
      return sessions.filter((s) => !s.recruiterId || s.recruiterId === user.userId);
    },
    async userStats() { return { total: 3, byRole: { CANDIDATE: 2, RECRUITER: 1 }, pendingApproval: 1 }; },
  });
  return svc;
}

const cand = { userId: 'c1', email: '', role: 'CANDIDATE' };
const rec = { userId: 'r1', email: '', role: 'RECRUITER' };
const admin = { userId: 'a', email: '', role: 'ADMIN' };

test('candidate dashboard: own sessions only, performance series, upcoming vs recent', async () => {
  const d: any = await (await seed()).candidate(cand);
  assert.equal(d.overview.totalSessions, 2);
  assert.equal(d.performance.completedInterviews, 1);
  assert.equal(d.performance.latestScore, 85);
  assert.equal(d.performance.series[0].theoryAverage, 90);
  assert.equal(d.performance.series[0].codingAverage, 80);
  assert.deepEqual(d.upcoming.map((s: any) => s.id), ['s3']);
  assert.deepEqual(d.recent.map((s: any) => s.id), ['s1']);
});

test('recruiter dashboard: candidates ranked by score, coding metrics across answers', async () => {
  const d: any = await (await seed()).recruiter(rec);
  assert.deepEqual(d.candidates.map((c: any) => c.candidateName), ['Ann', 'Bob', 'Ann']);
  assert.equal(d.candidates[0].recommendation, 'Hire');
  assert.equal(d.coding.evaluatedSubmissions, 2);
  assert.deepEqual(d.coding.correctness, { pass: 1, partial: 0, fail: 1 });
  assert.equal(d.overview.averageScore, 65);
});

test('admin dashboard: includes user stats and AI metrics; non-admin refused', async () => {
  const svc = await seed();
  const d: any = await svc.admin(admin);
  assert.equal(d.users.pendingApproval, 1);
  assert.equal(d.ai.totalCalls, 1);
  assert.equal(d.ai.successRate, 100);
  await assert.rejects(svc.admin(rec), (e: any) => e.statusCode === 403);
});

test('compare: ranks, validates input, hides nothing from recruiters, blocks candidates', async () => {
  const svc = await seed();
  const c: any = await svc.compare(rec, ['s2', 's1']);
  assert.deepEqual(c.candidates.map((x: any) => x.candidateName), ['Ann', 'Bob']);
  assert.equal(c.candidates[1].deltaFromBest, -40);
  assert.deepEqual(c.candidates[0].strengths, ['a']);
  await assert.rejects(svc.compare(rec, ['s1']), (e: any) => e.statusCode === 400);
  await assert.rejects(svc.compare(rec, ['s1', 'nope']), (e: any) => e.statusCode === 404);
  await assert.rejects(svc.compare(cand, ['s1', 's3']), (e: any) => e.statusCode === 403);
});
