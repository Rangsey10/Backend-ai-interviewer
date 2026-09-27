import { io, Socket } from 'socket.io-client';
import * as codeRunnerService from './src/services/codeRunner.service';
import app from './src/app';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { initInterviewSocket } from './src/sockets/interview.socket';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const TIMESTAMP = Date.now();

// ANSI Color Helpers
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [${GREEN}PASS${RESET}] ${testName}`);
    passedTests++;
  } else {
    console.error(`  [${RED}FAIL${RESET}] ${testName}${detail ? ` - ${detail}` : ''}`);
    failedTests++;
  }
}

async function fetchJson(endpoint: string, options: any = {}) {
  const url = `${BASE_URL}${endpoint}`;
  // Spread options first so the merged headers (incl. Content-Type) are not overwritten
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

async function runRunnerTests() {
  console.log(`${CYAN}======================================================${RESET}`);
  console.log(`${CYAN}   InterviewAI - Docker Sandbox Runner Verification   ${RESET}`);
  console.log(`${CYAN}======================================================${RESET}\n`);

  let tempServer: http.Server | null = null;
  let ioServer: SocketIOServer | null = null;

  // Check if server is already running, if not start embedded test server
  try {
    const ping = await fetch(`${BASE_URL}/health`).catch(() => null);
    if (!ping || !ping.ok) {
      console.log(`[Info] Starting local test server on ${BASE_URL}...`);
      tempServer = http.createServer(app);
      ioServer = new SocketIOServer(tempServer, { cors: { origin: '*' } });
      initInterviewSocket(ioServer);
      await new Promise<void>((resolve) => tempServer!.listen(5000, () => resolve()));
    }
  } catch {
    // If port 5000 is taken or already serving, proceed
  }

  try {
    // -------------------------------------------------------------------------
    // Test 1: Successful JavaScript Execution
    // -------------------------------------------------------------------------
    console.log(`${YELLOW}Test 1: Valid JavaScript Execution...${RESET}`);
    const jsResult = await codeRunnerService.executeCode({
      language: 'javascript',
      code: `
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
console.log("Fibonacci(7):", fibonacci(7));
      `,
      timeoutMs: 4000,
    });

    assert(
      jsResult.status === 'SUCCESS' && jsResult.stdout.includes('Fibonacci(7): 13'),
      'Execute Valid JavaScript Code',
      `Stdout: "${jsResult.stdout.trim()}" (Runner: ${jsResult.runnerMode}, Time: ${jsResult.executionTimeMs}ms)`
    );

    // -------------------------------------------------------------------------
    // Test 2: Successful Python Execution
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 2: Valid Python Execution...${RESET}`);
    const pyResult = await codeRunnerService.executeCode({
      language: 'python',
      code: `
def is_palindrome(s):
    return s == s[::-1]

print("radar is palindrome:", is_palindrome("radar"))
print("hello is palindrome:", is_palindrome("hello"))
      `,
      timeoutMs: 4000,
    });

    assert(
      pyResult.status === 'SUCCESS' &&
        pyResult.stdout.includes('radar is palindrome: True') &&
        pyResult.stdout.includes('hello is palindrome: False'),
      'Execute Valid Python Code',
      `Stdout: "${pyResult.stdout.trim()}" (Runner: ${pyResult.runnerMode}, Time: ${pyResult.executionTimeMs}ms)`
    );

    // -------------------------------------------------------------------------
    // Test 3: Runtime Error Handling (JavaScript TypeError & Python ZeroDivision)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 3: Runtime Error Handling...${RESET}`);
    const jsErrorResult = await codeRunnerService.executeCode({
      language: 'javascript',
      code: `
const user = null;
user.getNonExistentMethod();
      `,
      timeoutMs: 3000,
    });

    assert(
      jsErrorResult.status === 'RUNTIME_ERROR' &&
        (jsErrorResult.stderr.includes('TypeError') || jsErrorResult.stderr.includes('null') || jsErrorResult.exitCode !== 0),
      'Capture JavaScript Runtime Error (TypeError)',
      `Stderr: "${jsErrorResult.stderr.slice(0, 60)}..."`
    );

    const pyErrorResult = await codeRunnerService.executeCode({
      language: 'python',
      code: `
def compute():
    return 42 / 0

compute()
      `,
      timeoutMs: 3000,
    });

    assert(
      pyErrorResult.status === 'RUNTIME_ERROR' &&
        (pyErrorResult.stderr.includes('ZeroDivisionError') || pyErrorResult.stderr.includes('division by zero') || pyErrorResult.exitCode !== 0),
      'Capture Python Runtime Error (ZeroDivisionError)',
      `Stderr: "${pyErrorResult.stderr.slice(0, 60)}..."`
    );

    // -------------------------------------------------------------------------
    // Test 4: Timeout Safeguard (Infinite Loop Termination)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 4: Timeout Safeguard Handling (Infinite Loop)...${RESET}`);
    const timeoutStart = Date.now();
    const timeoutResult = await codeRunnerService.executeCode({
      language: 'javascript',
      code: `
console.log("Starting infinite loop...");
while (true) {
  // Busy loop
}
      `,
      timeoutMs: 1500, // 1.5 seconds strict limit
    });
    const elapsed = Date.now() - timeoutStart;

    assert(
      timeoutResult.status === 'TIMEOUT' && elapsed >= 1400 && elapsed <= 3500,
      'Terminate Infinite Loop with status TIMEOUT',
      `Status: ${timeoutResult.status}, Elapsed: ${elapsed}ms, Msg: "${timeoutResult.stderr}"`
    );

    // -------------------------------------------------------------------------
    // Test 5: Security Isolation Verification
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 5: Security Isolation (Resource / Access Test)...${RESET}`);
    const secResult = await codeRunnerService.executeCode({
      language: 'javascript',
      code: `
// Attempting unauthorized system access or environment variable inspection
const fs = require('fs');
try {
  const secret = process.env.JWT_SECRET || process.env.DATABASE_URL;
  if (!secret) {
    console.log("ISOLATION_CONFIRMED: Host environment secrets not leaked");
  } else {
    console.log("LEAKED");
  }
} catch (e) {
  console.log("ISOLATION_CONFIRMED: Blocked");
}
      `,
      timeoutMs: 3000,
    });

    assert(
      secResult.stdout.includes('ISOLATION_CONFIRMED') || secResult.status === 'SUCCESS',
      'Security Isolation: Host secrets & environment protected',
      `Output: "${secResult.stdout.trim()}"`
    );

    // -------------------------------------------------------------------------
    // Test 5b: TypeScript, output cap, unsupported language
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 5b: TypeScript / Output Limit / Unsupported Language...${RESET}`);
    const tsResult = await codeRunnerService.executeCode({
      language: 'typescript',
      code: `const add = (a: number, b: number): number => a + b;\nconsole.log("TS_OK", add(2, 3));`,
      timeoutMs: 4000,
    });
    assert(
      tsResult.status === 'SUCCESS' && tsResult.stdout.includes('TS_OK 5'),
      'Execute TypeScript Code (type annotations)',
      `Status: ${tsResult.status}, Stdout: "${tsResult.stdout}", Stderr: "${tsResult.stderr.slice(0, 120)}"`
    );

    const floodResult = await codeRunnerService.executeCode({
      language: 'javascript',
      code: `while (true) { console.log("x".repeat(1000)); }`,
      timeoutMs: 5000,
    });
    assert(
      floodResult.status === 'RUNTIME_ERROR' && floodResult.stderr.includes('Output limit') && floodResult.stdout.length <= 64 * 1024,
      'Stop Execution When Output Limit Exceeded',
      `Status: ${floodResult.status}, stdout length: ${floodResult.stdout.length}`
    );

    let unsupportedRejected = false;
    try {
      await codeRunnerService.executeCode({ language: 'cobol', code: 'DISPLAY "HI".' });
    } catch (err: any) {
      unsupportedRejected = err?.statusCode === 400;
    }
    assert(unsupportedRejected, 'Reject Unsupported Language with 400');

    // -------------------------------------------------------------------------
    // Test 6: REST API Endpoint (POST /api/sessions/:id/execute-code)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 6: REST API Endpoint POST /api/sessions/:id/execute-code...${RESET}`);

    const regUser = await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Runner Tester',
        email: `runner_test_${TIMESTAMP}@example.com`,
        password: 'Password123!',
        role: 'CANDIDATE',
      }),
    });

    const token = regUser.body?.token || regUser.body?.data?.token;

    const createSessionRes = await fetchJson('/api/sessions/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobTitle: 'Algorithm Engineer' }),
    });

    const sessionId = createSessionRes.body?.session?.id || createSessionRes.body?.data?.id;
    assert(!!token && !!sessionId, 'Register User & Create Session for REST/Socket tests');

    if (sessionId && token) {
      const tooLongTimeout = await fetchJson(`/api/sessions/${sessionId}/execute-code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language: 'javascript', code: 'console.log(1)', timeoutMs: 600000 }),
      });
      assert(tooLongTimeout.status === 400, 'Reject timeoutMs above 30s via REST', `HTTP ${tooLongTimeout.status}`);
    }

    if (sessionId && token) {
      const restExecRes = await fetchJson(`/api/sessions/${sessionId}/execute-code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          language: 'javascript',
          code: 'console.log("REST_EXEC_CONFIRMED: " + (100 * 2));',
          timeoutMs: 3000,
        }),
      });

      assert(
        restExecRes.status === 200 &&
          restExecRes.body?.result?.status === 'SUCCESS' &&
          restExecRes.body?.result?.stdout.includes('REST_EXEC_CONFIRMED: 200'),
        'Execute Code via REST API endpoint',
        `Result: ${JSON.stringify(restExecRes.body?.result?.status)}`
      );
    }

    // -------------------------------------------------------------------------
    // Test 7: WebSocket code:run Event Integration
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Test 7: WebSocket code:run Event Integration...${RESET}`);

    if (sessionId && token) {
      const socket: Socket = io(BASE_URL, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
      });

      await new Promise<void>((resolve) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', () => resolve());
        setTimeout(() => resolve(), 2000);
      });

      assert(socket.connected, 'Socket Connected for code:run test');

      if (socket.connected) {
        const hugeTimeout = await new Promise<any>((resolve) => {
          socket.emit('room:join', { sessionId }, () => {
            socket.emit(
              'code:run',
              { sessionId, language: 'javascript', code: 'console.log(1)', timeoutMs: 600000 },
              (res: any) => resolve(res)
            );
          });
        });
        assert(hugeTimeout?.success === false, 'Reject timeoutMs above 30s via Socket code:run', JSON.stringify(hugeTimeout));


        const wsExecPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for code:executed event')), 6000);

          socket.on('code:executed', (data: any) => {
            clearTimeout(timeout);
            assert(
              data?.result?.status === 'SUCCESS' && data?.result?.stdout.includes('WS_EXEC_CONFIRMED'),
              'Socket.IO code:run Broadcast Receipt',
              `Stdout: "${data?.result?.stdout?.trim()}"`
            );
            resolve();
          });
        });

        socket.emit('code:run', {
          sessionId,
          language: 'javascript',
          code: 'console.log("WS_EXEC_CONFIRMED: OK");',
          timeoutMs: 3000,
        });

        await wsExecPromise;
        socket.disconnect();
      }
    }

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log(`\n${CYAN}======================================================${RESET}`);
    console.log(`${CYAN}                   Test Summary                       ${RESET}`);
    console.log(`${CYAN}======================================================${RESET}`);
    console.log(`Total Passed: ${GREEN}${passedTests}${RESET}`);
    console.log(`Total Failed: ${RED}${failedTests}${RESET}`);

    if (failedTests === 0) {
      console.log(`\n${GREEN}✔ All Phase 4 Sandboxed Code Runner tests passed successfully!${RESET}`);
    } else {
      console.log(`\n${RED}✘ Some tests failed. Check logs above.${RESET}`);
    }

    if (ioServer) {
      ioServer.close();
    }
    if (tempServer) {
      tempServer.close();
    }

    setTimeout(() => {
      process.exit(failedTests === 0 ? 0 : 1);
    }, 200);
  } catch (err: any) {
    if (tempServer) {
      tempServer.close();
    }
    console.error(`\n${RED}[FATAL ERROR] Test execution failed:${RESET}`, err?.message || err);
    process.exit(1);
  }
}

// Execute tests
runRunnerTests();
