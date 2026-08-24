import { io, Socket } from 'socket.io-client';
import app from './src/app';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { initInterviewSocket } from './src/sockets/interview.socket';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const TIMESTAMP = Date.now();

const CANDIDATE_CREDENTIALS = {
  fullName: 'Candidate Socket Tester',
  email: `candidate_socket_${TIMESTAMP}@example.com`,
  password: 'Password123!',
  role: 'CANDIDATE',
};

const RECRUITER_CREDENTIALS = {
  fullName: 'Recruiter Socket Observer',
  email: `recruiter_socket_${TIMESTAMP}@example.com`,
  password: 'Password123!',
  role: 'RECRUITER',
};

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

async function runSocketVerification() {
  console.log(`${CYAN}======================================================${RESET}`);
  console.log(`${CYAN}   InterviewAI - Socket.IO Live Engine Verification   ${RESET}`);
  console.log(`${CYAN}======================================================${RESET}`);
  console.log(`Target URL: ${BASE_URL}\n`);

  let tempServer: http.Server | null = null;
  let ioServer: SocketIOServer | null = null;

  try {
    const ping = await fetch(`${BASE_URL}/health`).catch(() => null);
    if (!ping || !ping.ok) {
      console.log(`[Info] Starting local test server on ${BASE_URL}...`);
      tempServer = http.createServer(app);
      ioServer = new SocketIOServer(tempServer, { cors: { origin: '*' } });
      initInterviewSocket(ioServer);
      await new Promise<void>((resolve) => tempServer!.listen(5000, () => resolve()));
    }
  } catch {}

  try {
    // -------------------------------------------------------------------------
    // Step 1: Register Candidate & Recruiter
    // -------------------------------------------------------------------------
    console.log(`${YELLOW}Step 1: Registering Candidate & Recruiter...${RESET}`);
    const regCand = await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(CANDIDATE_CREDENTIALS),
    });
    assert(regCand.status === 201, 'Register Candidate User');

    const regRecruiter = await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(RECRUITER_CREDENTIALS),
    });
    assert(regRecruiter.status === 201, 'Register Recruiter User');

    // -------------------------------------------------------------------------
    // Step 2: Login to extract JWT Tokens
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 2: Logging in to extract JWT tokens...${RESET}`);
    const loginCand = await fetchJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: CANDIDATE_CREDENTIALS.email,
        password: CANDIDATE_CREDENTIALS.password,
      }),
    });
    const candidateToken = loginCand.body?.token || loginCand.body?.data?.token;
    assert(!!candidateToken, 'Candidate Login & Token Extraction');

    const loginRecruiter = await fetchJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: RECRUITER_CREDENTIALS.email,
        password: RECRUITER_CREDENTIALS.password,
      }),
    });
    const recruiterToken = loginRecruiter.body?.token || loginRecruiter.body?.data?.token;
    assert(!!recruiterToken, 'Recruiter Login & Token Extraction');

    // -------------------------------------------------------------------------
    // Step 3: Create an Interview Session Room via REST API
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 3: Creating Interview Session Room via /api/sessions/create...${RESET}`);
    const sessionRes = await fetchJson('/api/sessions/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${candidateToken}` },
      body: JSON.stringify({
        jobTitle: 'Senior Full Stack Engineer',
        jobDescription: 'Design scalable distributed real-time interview systems.',
        resumeText: 'Experienced TypeScript and Node.js developer.',
        initialCode: '// Live Coding Challenge\nfunction solve() {\n  return "Initial Code";\n}\n',
      }),
    });

    const sessionId = sessionRes.body?.session?.id || sessionRes.body?.data?.id;
    assert(sessionRes.status === 201 && !!sessionId, 'Create Interview Session Room', `Session ID: ${sessionId}`);

    // Verify GET /api/sessions/:id
    const getSessionRes = await fetchJson(`/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${candidateToken}` },
    });
    assert(getSessionRes.status === 200, 'Fetch Session Details via GET /api/sessions/:id');

    // -------------------------------------------------------------------------
    // Step 4: Connect Candidate and Recruiter Socket.IO Clients
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 4: Connecting Candidate & Recruiter Socket Clients...${RESET}`);

    const candidateSocket: Socket = io(BASE_URL, {
      auth: { token: candidateToken },
      transports: ['websocket'],
      reconnection: false,
    });

    const recruiterSocket: Socket = io(BASE_URL, {
      auth: { token: recruiterToken },
      transports: ['websocket'],
      reconnection: false,
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        candidateSocket.on('connect', () => resolve());
        candidateSocket.on('connect_error', (err) => reject(new Error(`Candidate socket connect error: ${err.message}`)));
      }),
      new Promise<void>((resolve, reject) => {
        recruiterSocket.on('connect', () => resolve());
        recruiterSocket.on('connect_error', (err) => reject(new Error(`Recruiter socket connect error: ${err.message}`)));
      }),
    ]);

    assert(candidateSocket.connected, 'Candidate Socket Connected & Authenticated');
    assert(recruiterSocket.connected, 'Recruiter Socket Connected & Authenticated');

    // -------------------------------------------------------------------------
    // Step 5: Join Interview Room (room:join)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 5: Joining Room interview:${sessionId}...${RESET}`);

    await Promise.all([
      new Promise<void>((resolve) => {
        candidateSocket.emit('room:join', { sessionId }, (res: any) => {
          assert(res?.success === true, 'Candidate Joined Room confirmation');
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        recruiterSocket.emit('room:join', { sessionId }, (res: any) => {
          assert(res?.success === true, 'Recruiter Observer Joined Room confirmation');
          resolve();
        });
      }),
    ]);

    // -------------------------------------------------------------------------
    // Step 6: Test Live Code Sync (code:change -> code:update)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 6: Testing Real-Time Code Sync (Candidate -> Recruiter)...${RESET}`);
    const testCode = `function reverseString(str: string): string {\n  return str.split('').reverse().join('');\n}`;

    const codeSyncPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for code:update event')), 5000);

      recruiterSocket.once('code:update', (data: any) => {
        clearTimeout(timeout);
        assert(data?.code === testCode, 'Recruiter Received Live Code Update broadcast', `Received: ${data?.code?.slice(0, 30)}...`);
        resolve();
      });
    });

    candidateSocket.emit('code:change', {
      sessionId,
      code: testCode,
      cursorPosition: { lineNumber: 2, column: 15 },
    });

    await codeSyncPromise;

    // -------------------------------------------------------------------------
    // Step 7: Test Real-Time Chat (chat:message)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 7: Testing Real-Time Chat Message Broadcast...${RESET}`);
    const chatText = 'Hello! I have completed the function implementation.';

    const chatSyncPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for chat:message event')), 5000);

      recruiterSocket.once('chat:message', (data: any) => {
        clearTimeout(timeout);
        assert(data?.message === chatText, 'Recruiter Received Chat Message broadcast', `Message: "${data?.message}"`);
        resolve();
      });
    });

    candidateSocket.emit('chat:message', {
      sessionId,
      message: chatText,
    });

    await chatSyncPromise;

    // -------------------------------------------------------------------------
    // Step 8: Test Recruiter Intervention (recruiter:intervene)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 8: Testing Recruiter Intervention Broadcast...${RESET}`);
    const interventionContent = 'Great! What is the time complexity of this solution?';

    const interventionPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for recruiter:intervened event')), 5000);

      candidateSocket.once('recruiter:intervened', (data: any) => {
        clearTimeout(timeout);
        assert(
          data?.content === interventionContent && data?.interventionType === 'question',
          'Candidate Received Recruiter Intervention event',
          `Intervention: "${data?.content}"`
        );
        resolve();
      });
    });

    recruiterSocket.emit('recruiter:intervene', {
      sessionId,
      interventionType: 'question',
      content: interventionContent,
    });

    await interventionPromise;

    // -------------------------------------------------------------------------
    // Step 9: Update Session Status (PATCH /api/sessions/:id/status)
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 9: Updating Session Status to COMPLETED...${RESET}`);
    const updateStatusRes = await fetchJson(`/api/sessions/${sessionId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${candidateToken}` },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    assert(
      updateStatusRes.status === 200 && updateStatusRes.body?.session?.status === 'COMPLETED',
      'Update Session Status via PATCH /api/sessions/:id/status'
    );

    // -------------------------------------------------------------------------
    // Step 10: Clean Disconnect
    // -------------------------------------------------------------------------
    console.log(`\n${YELLOW}Step 10: Disconnecting Sockets Cleanly...${RESET}`);
    candidateSocket.disconnect();
    recruiterSocket.disconnect();
    assert(!candidateSocket.connected && !recruiterSocket.connected, 'Sockets Disconnected Cleanly');

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log(`\n${CYAN}======================================================${RESET}`);
    console.log(`${CYAN}                   Test Summary                       ${RESET}`);
    console.log(`${CYAN}======================================================${RESET}`);
    console.log(`Total Passed: ${GREEN}${passedTests}${RESET}`);
    console.log(`Total Failed: ${RED}${failedTests}${RESET}`);

    if (ioServer) ioServer.close();
    if (tempServer) tempServer.close();

    setTimeout(() => {
      process.exit(failedTests === 0 ? 0 : 1);
    }, 200);
  } catch (err: any) {
    if (tempServer) tempServer.close();
    console.error(`\n${RED}[FATAL ERROR] Test execution failed:${RESET}`, err?.message || err);
    process.exit(1);
  }
}

// Execute tests
runSocketVerification();
