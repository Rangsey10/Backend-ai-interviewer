import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createAiClient } from '../src/lib/aiClient';
import { createRateLimiter } from '../src/lib/rateLimiter';
import { createMemoryDb } from '../src/store/db';
import { createInterviewService, SessionLike, Actor } from '../src/services/interview.service';

/** Stub of the AI service: records requests, answers per path */
async function stubAi(handlers: Record<string, (body: any) => { status?: number; body: any }>) {
  const seen: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url!, body });
      const h = handlers[req.url!];
      const out = h ? h(body) : { status: 404, body: { success: false, error: 'nope' } };
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

const candidate: Actor = { userId: 'cand', email: 'c@x.io', role: 'CANDIDATE' };
const recruiter: Actor = { userId: 'rec', email: 'r@x.io', role: 'RECRUITER' };
const stranger: Actor = { userId: 'other', email: 'o@x.io', role: 'CANDIDATE' };

function setup(url: string, limit = 100) {
  const db = createMemoryDb();
  const statuses: Record<string, string> = {};
  const session: SessionLike = { id: 's1', candidateId: 'cand', recruiterId: 'rec', jobTitle: 'Backend Dev', status: 'SCHEDULED', candidate: { fullName: 'Cand Idate' } };
  const svc = createInterviewService({
    ai: createAiClient({ baseUrl: url, timeoutMs: 3000, maxRetries: 0 }),
    db,
    limiter: createRateLimiter(limit, 60_000),
    async getSession(id, user) {
      const ok = user.role === 'ADMIN' || user.userId === session.candidateId || user.userId === session.recruiterId;
      if (id !== session.id || !ok) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return session;
    },
    async setSessionStatus(id, status) { statuses[id] = status; },
  });
  return { db, svc, statuses };
}

const questionsResponse = {
  success: true,
  data: { questions: [
    { id: 'q1', type: 'theoretical', topic: 'REST', difficulty: 'easy', skills: ['http'], estimated_time: 5, question_text: 'What is REST?' },
    { id: 'q2', type: 'coding', topic: 'Strings', difficulty: 'medium', skills: ['js'], estimated_time: 15, question_text: 'First unique char' },
  ] },
};

test('generateQuestions strips sessionId, stores questions, returns the AI data untouched', async () => {
  const ai = await stubAi({ '/api/ai/questions': () => ({ body: questionsResponse }) });
  const { svc, db } = setup(ai.url);
  const out: any = await svc.generateQuestions(candidate, 'questions', { sessionId: 's1', jobTitle: 'Backend Dev' });
  assert.equal(out.questions.length, 2);
  assert.deepEqual(ai.seen[0].body, { jobTitle: 'Backend Dev' }, 'tracking keys must not reach the AI service');
  const stored = await db.listQuestions('s1');
  assert.deepEqual(stored.map((q) => q.text), ['What is REST?', 'First unique char']);
  assert.equal(stored[1].meta?.aiId, 'q2');
  assert.deepEqual(stored[0].meta?.skills, ['http']);
  await ai.close();
});

test('without a sessionId the call is a plain pass-through that stores nothing', async () => {
  const ai = await stubAi({ '/api/ai/questions': () => ({ body: questionsResponse }) });
  const { svc, db } = setup(ai.url);
  await svc.generateQuestions(candidate, 'questions', { jobTitle: 'x' });
  assert.equal((await db.listQuestions('s1')).length, 0);
  await ai.close();
});

test('a user without access to the session is rejected BEFORE any AI call is made', async () => {
  const ai = await stubAi({ '/api/ai/questions': () => ({ body: questionsResponse }) });
  const { svc } = setup(ai.url);
  await assert.rejects(svc.generateQuestions(stranger, 'questions', { sessionId: 's1' }), /not found/);
  assert.equal(ai.seen.length, 0);
  await ai.close();
});

test('feedback + follow-up + code evaluation are stored on the right answers with normalised scores', async () => {
  const ai = await stubAi({
    '/api/ai/questions': () => ({ body: questionsResponse }),
    '/api/ai/feedback': () => ({ body: { success: true, data: { score: 7, strengths: ['a'], weaknesses: [], feedback: 'ok', missed_key_points: ['x'] } } }),
    '/api/ai/follow-up-questions': () => ({ body: { success: true, data: { follow_up_needed: true, reason: 'r', follow_up_question: 'why?' } } }),
    '/api/submissions/execute': () => ({ body: { success: true, data: { score: 64, correctness: 'partial', edge_cases_missed: ['empty'] } } }),
  });
  const { svc, db } = setup(ai.url);
  await svc.generateQuestions(candidate, 'questions', { sessionId: 's1' });
  await svc.feedback(candidate, { sessionId: 's1', questionId: 'q1', candidateAnswer: 'REST is...', jobTitle: 'x' });
  await svc.followUp(candidate, { sessionId: 's1', questionId: 'q1', candidateAnswer: 'REST is...' });
  await svc.executeCode(candidate, { sessionId: 's1', questionId: 'q2', candidateCode: 'code()', programmingLanguage: 'JavaScript' });

  const answers = await db.listAnswers(['s1']);
  const theory = answers.find((a) => a.question.meta?.aiId === 'q1')!;
  const coding = answers.find((a) => a.question.meta?.aiId === 'q2')!;
  assert.equal(theory.answerText, 'REST is...');
  assert.equal(theory.score, 70, '0-10 feedback score becomes 0-100');
  assert.equal(theory.followUp.follow_up_question, 'why?');
  assert.equal(coding.submittedCode, 'code()');
  assert.equal(coding.language, 'JavaScript');
  assert.equal(coding.score, 64);
  assert.equal(coding.codeEvaluation.correctness, 'partial');
  await ai.close();
});

test('only the interviewed candidate may submit answers; recruiter gets 403, unknown question 404', async () => {
  const ai = await stubAi({ '/api/ai/questions': () => ({ body: questionsResponse }), '/api/ai/feedback': () => ({ body: { success: true, data: { score: 5 } } }) });
  const { svc } = setup(ai.url);
  await svc.generateQuestions(candidate, 'questions', { sessionId: 's1' });
  await assert.rejects(svc.feedback(recruiter, { sessionId: 's1', questionId: 'q1', candidateAnswer: 'x' }), (e: any) => e.statusCode === 403);
  await assert.rejects(svc.feedback(candidate, { sessionId: 's1', questionId: 'q99', candidateAnswer: 'x' }), (e: any) => e.statusCode === 404);
  await ai.close();
});

test('finalReport builds its input from stored data, saves the result, completes the session, notifies both sides', async () => {
  const ai = await stubAi({
    '/api/ai/questions': () => ({ body: questionsResponse }),
    '/api/ai/feedback': () => ({ body: { success: true, data: { score: 8, missed_key_points: ['m'] } } }),
    '/api/ai/final-report': () => ({ body: { success: true, data: {
      candidate_name: 'Cand Idate', job_title: 'Backend Dev', overall_score: 82, technical_evaluation: 't', communication_evaluation: 'c',
      strengths: ['s'], weaknesses: ['w'], recommendation: 'Hire', recommendation_justification: 'because', summary: 'good' } } }),
  });
  const { svc, db, statuses } = setup(ai.url);
  await svc.generateQuestions(candidate, 'questions', { sessionId: 's1' });
  await svc.feedback(candidate, { sessionId: 's1', questionId: 'q1', candidateAnswer: 'my answer' });
  await svc.finalReport(candidate, { sessionId: 's1' });

  const req = ai.seen.find((s) => s.path === '/api/ai/final-report')!.body;
  assert.equal(req.candidateName, 'Cand Idate');
  assert.match(req.interviewTranscript, /Q1: What is REST\?\nA1: my answer/);
  assert.match(req.interviewTranscript, /Q2: First unique char\nA2: No answer/);
  assert.deepEqual(req.perQuestionFeedback, [{ score: 8, missed_key_points: ['m'] }]);
  assert.equal(req.sessionId, undefined);

  const [result] = await db.listResults(['s1']);
  assert.equal(result.score, 82);
  assert.equal(result.recommendation, 'Hire');
  assert.equal(statuses.s1, 'COMPLETED');
  assert.equal((await db.listNotifications('cand'))[0].type, 'FEEDBACK_READY');
  assert.equal((await db.listNotifications('rec'))[0].type, 'INTERVIEW_COMPLETED');
  await ai.close();
});

test('getReport hides the hiring recommendation from candidates but not from recruiters', async () => {
  const ai = await stubAi({
    '/api/ai/questions': () => ({ body: questionsResponse }),
    '/api/ai/final-report': () => ({ body: { success: true, data: { overall_score: 90, recommendation: 'Strong Hire', recommendation_justification: 'j', summary: 's', strengths: [], weaknesses: [] } } }),
  });
  const { svc } = setup(ai.url);
  await svc.generateQuestions(candidate, 'questions', { sessionId: 's1' });
  await svc.finalReport(candidate, { sessionId: 's1' });
  const forCandidate: any = await svc.getReport(candidate, 's1');
  assert.equal(forCandidate.recommendation, null);
  assert.equal(forCandidate.report.recommendation, undefined);
  assert.equal(forCandidate.report.recommendation_justification, undefined);
  assert.equal(forCandidate.report.summary, 's');
  const forRecruiter: any = await svc.getReport(recruiter, 's1');
  assert.equal(forRecruiter.recommendation, 'Strong Hire');
  assert.equal(forRecruiter.overallScore, 90);
  await ai.close();
});

test('AI failures are logged, rate limit returns 429, and an AI outage maps to 503', async () => {
  const ai = await stubAi({ '/api/ai/feedback': () => ({ status: 400, body: { success: false, error: 'candidateAnswer is required' } }) });
  const { svc, db } = setup(ai.url, 2);
  await assert.rejects(svc.feedback(candidate, { candidateAnswer: '' }), (e: any) => e.statusCode === 400 && /required/.test(e.message));
  await assert.rejects(svc.feedback(candidate, {}), (e: any) => e.statusCode === 400);
  await assert.rejects(svc.feedback(candidate, {}), (e: any) => e.statusCode === 429);
  const logs = await db.listAiLogs(new Date(0));
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => !l.ok && l.feature === 'feedback'));
  await ai.close();

  const down = setup('http://127.0.0.1:1');
  await assert.rejects(down.svc.feedback(candidate, {}), (e: any) => e.statusCode === 503);
});

test('rejects non-object bodies', async () => {
  const { svc } = setup('http://127.0.0.1:1');
  await assert.rejects(svc.feedback(candidate, null), (e: any) => e.statusCode === 400);
  await assert.rejects(svc.feedback(candidate, []), (e: any) => e.statusCode === 400);
});

test('saveQuestions validates input, stores the edited list, and notifies the candidate (not the author)', async () => {
  const { svc, db } = setup('http://127.0.0.1:1');
  await assert.rejects(svc.saveQuestions(recruiter, 's1', []), (e: any) => e.statusCode === 400);
  await assert.rejects(svc.saveQuestions(recruiter, 's1', [{ type: 'coding' }]), (e: any) => e.statusCode === 400);
  const saved = await svc.saveQuestions(recruiter, 's1', [
    { id: 'q-1', type: 'theoretical', topic: 'SQL', question_text: 'What is an index?' },
    { id: 'q-2', type: 'coding', question_text: 'Reverse a string' },
  ]);
  assert.deepEqual(saved.map((q) => q.text), ['What is an index?', 'Reverse a string']);
  assert.equal(saved[0].meta?.aiId, 'q-1');
  assert.equal((await db.listNotifications('cand'))[0].type, 'INTERVIEW_SCHEDULED');
  await svc.saveQuestions(candidate, 's1', [{ question_text: 'x' }]);
  assert.equal((await db.listNotifications('cand')).length, 1, 'no self-notification');
});
