import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAiClient, AiCallError } from '../src/lib/aiClient';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, count: number) => void;

async function withServer(handler: Handler, run: (baseUrl: string, hits: () => number) => Promise<void>) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    handler(req, res, count);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, () => count);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const noSleep = async () => {};

test('unwraps { success, data } and sends the JSON body', async () => {
  let received = '';
  await withServer(
    (req, res) => {
      req.on('data', (c) => (received += c));
      req.on('end', () => json(res, 200, { success: true, data: { questions: [{ id: 'q1' }] } }));
    },
    async (baseUrl) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 1, sleep: noSleep });
      const result = await client.post<{ questions: { id: string }[] }>('/api/ai/questions', { jobTitle: 'Dev' });
      assert.deepEqual(result.data, { questions: [{ id: 'q1' }] });
      assert.equal(result.attempts, 1);
      assert.deepEqual(JSON.parse(received), { jobTitle: 'Dev' });
    }
  );
});

test('a 4xx from the AI service is surfaced and never retried', async () => {
  await withServer(
    (_req, res) => json(res, 400, { success: false, error: 'jobTitle is required' }),
    async (baseUrl, hits) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 2, sleep: noSleep });
      await assert.rejects(
        () => client.post('/api/ai/questions', {}),
        (err: any) => err instanceof AiCallError && err.statusCode === 400 && /jobTitle is required/.test(err.message)
      );
      assert.equal(hits(), 1);
    }
  );
});

test('a plain 500 (model failure after the AI service retried) becomes 502 and is not retried', async () => {
  await withServer(
    (_req, res) => json(res, 500, { success: false, error: 'AI-006 failed after 3 attempt(s)' }),
    async (baseUrl, hits) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 2, sleep: noSleep });
      await assert.rejects(
        () => client.post('/api/ai/feedback', {}),
        (err: any) => err.statusCode === 502 && /AI service error: AI-006 failed/.test(err.message) && err.attempts === 1
      );
      assert.equal(hits(), 1);
    }
  );
});

test('a transient 503 is retried and the second attempt succeeds', async () => {
  await withServer(
    (_req, res, count) =>
      count === 1 ? json(res, 503, { success: false, error: 'busy' }) : json(res, 200, { success: true, data: { ok: 1 } }),
    async (baseUrl, hits) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 1, sleep: noSleep });
      const result = await client.post<{ ok: number }>('/x', {});
      assert.equal(result.data.ok, 1);
      assert.equal(result.attempts, 2);
      assert.equal(hits(), 2);
    }
  );
});

test('an unreachable AI service gives 503 after exhausting retries', async () => {
  // port 1 on localhost: connection refused
  const client = createAiClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, maxRetries: 2, sleep: noSleep });
  await assert.rejects(
    () => client.post('/x', {}),
    (err: any) => err instanceof AiCallError && err.statusCode === 503 && err.attempts === 3 && /unreachable/.test(err.message)
  );
});

test('a slow AI service times out with 504 and is not retried', async () => {
  await withServer(
    () => {
      /* never answers */
    },
    async (baseUrl, hits) => {
      const client = createAiClient({ baseUrl, timeoutMs: 150, maxRetries: 2, sleep: noSleep });
      await assert.rejects(
        () => client.post('/x', {}),
        (err: any) => err.statusCode === 504 && err.attempts === 1
      );
      assert.equal(hits(), 1);
    }
  );
});

test('a non-JSON reply is a 502', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>proxy error</html>');
    },
    async (baseUrl) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 0, sleep: noSleep });
      await assert.rejects(() => client.post('/x', {}), (err: any) => err.statusCode === 502 && /unreadable/.test(err.message));
    }
  );
});

test('{ success: false } with HTTP 200 is treated as a failure', async () => {
  await withServer(
    (_req, res) => json(res, 200, { success: false, error: 'nope' }),
    async (baseUrl) => {
      const client = createAiClient({ baseUrl, timeoutMs: 2000, maxRetries: 0, sleep: noSleep });
      await assert.rejects(() => client.post('/x', {}), (err: any) => err.statusCode === 502 && /nope/.test(err.message));
    }
  );
});

test('ping reports reachability', async () => {
  await withServer(
    (_req, res) => json(res, 200, { message: 'Hello from the backend!' }),
    async (baseUrl) => {
      assert.equal(await createAiClient({ baseUrl, timeoutMs: 1000, maxRetries: 0 }).ping(), true);
    }
  );
  assert.equal(await createAiClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, maxRetries: 0 }).ping(500), false);
});
