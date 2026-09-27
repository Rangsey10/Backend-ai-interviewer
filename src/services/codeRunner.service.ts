import { spawn, execSync, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { env } from '../config/env';
import { AppError } from '../middlewares/errorHandler';
import { CodeExecutionResult, ExecuteCodeInput, ExecutionStatus } from '../types/codeRunner.types';

type Language = 'javascript' | 'typescript' | 'python';
type RunnerMode = NonNullable<CodeExecutionResult['runnerMode']>;

const DOCKER_IMAGE = process.env.RUNNER_DOCKER_IMAGE || 'interviewai-runner:latest';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 64 * 1024; // per stream; protects server memory from print-loops
const DOCKER_CHECK_TTL_MS = 30_000;

// Docker availability is re-checked periodically so starting Docker later is picked up
let dockerCheck: { available: boolean; checkedAt: number } | null = null;

// Users with an execution in flight (one run at a time per user)
const activeRuns = new Set<string>();

let warnedUnsandboxed = false;

/**
 * Checks if Docker CLI and daemon are operational
 */
export function isDockerAvailable(): boolean {
  if (dockerCheck && Date.now() - dockerCheck.checkedAt < DOCKER_CHECK_TTL_MS) {
    return dockerCheck.available;
  }

  let available: boolean;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 1500 });
    available = true;
  } catch {
    available = false;
  }

  dockerCheck = { available, checkedAt: Date.now() };
  return available;
}

/**
 * Normalizes programming language string
 */
export function normalizeLanguage(lang: string): Language {
  const clean = (lang || '').toLowerCase().trim();
  if (clean === 'javascript' || clean === 'js' || clean === 'node') {
    return 'javascript';
  }
  if (clean === 'typescript' || clean === 'ts') {
    return 'typescript';
  }
  if (clean === 'python' || clean === 'python3' || clean === 'py') {
    return 'python';
  }
  throw new AppError(`Unsupported language '${lang}'. Supported: javascript, typescript, python`, 400);
}

/**
 * Runs code on behalf of a user, allowing only one concurrent execution per user
 */
export async function executeCodeForUser(userId: string, input: ExecuteCodeInput): Promise<CodeExecutionResult> {
  if (activeRuns.has(userId)) {
    throw new AppError('You already have code running. Wait for it to finish.', 429);
  }

  activeRuns.add(userId);
  try {
    return await executeCode(input);
  } finally {
    activeRuns.delete(userId);
  }
}

/**
 * Main Sandboxed Code Execution Entrypoint
 */
export async function executeCode(input: ExecuteCodeInput): Promise<CodeExecutionResult> {
  const language = normalizeLanguage(input.language);
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const code = input.code || '';

  if (isDockerAvailable()) {
    return runInDockerSandbox(language, code, timeoutMs);
  }

  if (!env.ALLOW_UNSANDBOXED_RUNNER) {
    throw new AppError(
      'Code runner unavailable: Docker is not running. (For local development only, set ALLOW_UNSANDBOXED_RUNNER=true.)',
      503
    );
  }

  if (!warnedUnsandboxed) {
    console.warn('⚠️  Docker unavailable — running candidate code UNSANDBOXED on the host (ALLOW_UNSANDBOXED_RUNNER=true).');
    warnedUnsandboxed = true;
  }
  return runInHostProcess(language, code, timeoutMs);
}

function nodeArgs(language: Language, file: string): string[] {
  // Node >= 22.6 can run TypeScript by stripping type annotations
  return language === 'typescript' ? ['--experimental-strip-types', '--no-warnings', file] : [file];
}

/**
 * Runs code inside an isolated, ephemeral Docker container
 * Security constraints:
 *   - --rm (Ephemeral auto-cleanup)
 *   - --network none (Zero outbound network access)
 *   - --memory 128m / --cpus 0.5 / --pids-limit 64 (resource + fork-bomb limits)
 *   - --read-only root filesystem, small tmpfs at /tmp
 *   - --cap-drop ALL, no-new-privileges, non-root user (from image)
 * Code is passed over stdin, so its size is not limited by command-line length.
 */
async function runInDockerSandbox(language: Language, code: string, timeoutMs: number): Promise<CodeExecutionResult> {
  const containerName = `interviewai-run-${randomUUID()}`;
  const file = language === 'python' ? '/tmp/main.py' : language === 'typescript' ? '/tmp/main.ts' : '/tmp/main.js';
  const runCmd = language === 'python' ? `python3 ${file}` : `node ${nodeArgs(language, file).join(' ')}`;

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--name', containerName,
    '--network', 'none',
    '--memory', '128m',
    '--cpus', '0.5',
    '--pids-limit', '64',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=16m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    DOCKER_IMAGE,
    'sh', '-c', `cat > ${file} && ${runCmd}`,
  ];

  const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin?.on('error', () => {}); // EPIPE if the container exits before reading all input
  child.stdin?.end(code, 'utf8');

  // Killing the local `docker` client does not necessarily stop the container
  const killContainer = () => {
    spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => {});
  };

  return collectResult(child, timeoutMs, 'DOCKER', killContainer);
}

/**
 * Development-only fallback: runs code directly on the host with a timeout.
 * This is NOT a sandbox — the code can read files and use the network.
 */
async function runInHostProcess(language: Language, code: string, timeoutMs: number): Promise<CodeExecutionResult> {
  const tmpDir = os.tmpdir();
  const ext = language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js';
  const filePath = path.join(tmpDir, `interviewai_${randomUUID()}.${ext}`);

  try {
    fs.writeFileSync(filePath, code, 'utf8');
  } catch (err: any) {
    return {
      status: 'RUNTIME_ERROR',
      stdout: '',
      stderr: `Failed to write code file: ${err.message}`,
      executionTimeMs: 0,
      exitCode: 1,
      runnerMode: 'ISOLATED_PROCESS',
    };
  }

  const cmd = language === 'python' ? (process.platform === 'win32' ? 'python' : 'python3') : process.execPath;
  const args = language === 'python' ? [filePath] : nodeArgs(language, filePath);

  const child = spawn(cmd, args, {
    cwd: tmpDir,
    // Minimal environment so server secrets (JWT_SECRET, DATABASE_URL, ...) are not inherited
    env: {
      NODE_ENV: 'production',
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT, // required by Python on Windows
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    return await collectResult(child, timeoutMs, 'ISOLATED_PROCESS');
  } finally {
    cleanupFile(filePath);
  }
}

/**
 * Collects capped stdout/stderr, enforces the timeout, and builds the result.
 * Success is determined by exit code only.
 */
function collectResult(
  child: ChildProcess,
  timeoutMs: number,
  runnerMode: RunnerMode,
  onKill?: () => void
): Promise<CodeExecutionResult> {
  const startTime = Date.now();

  return new Promise<CodeExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {}
      onKill?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        if (!outputTruncated) {
          outputTruncated = true;
          kill();
        }
        return next.slice(0, MAX_OUTPUT_BYTES);
      }
      return next;
    };

    child.stdout?.on('data', (data: Buffer) => {
      if (!outputTruncated) stdout = append(stdout, data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (!outputTruncated) stderr = append(stderr, data);
    });

    const finish = (result: Omit<CodeExecutionResult, 'executionTimeMs' | 'runnerMode'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, executionTimeMs: Date.now() - startTime, runnerMode });
    };

    child.on('error', (err) => {
      finish({
        status: 'RUNTIME_ERROR',
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        exitCode: 1,
      });
    });

    child.on('close', (exitCode) => {
      if (timedOut) {
        return finish({
          status: 'TIMEOUT',
          stdout,
          stderr: `Execution timed out after ${timeoutMs}ms`,
          exitCode: 124,
        });
      }

      if (outputTruncated) {
        return finish({
          status: 'RUNTIME_ERROR',
          stdout: stdout.trimEnd(),
          stderr: `${stderr.trimEnd()}\nOutput limit of ${MAX_OUTPUT_BYTES / 1024}KB exceeded; execution stopped.`.trim(),
          exitCode: exitCode ?? 1,
        });
      }

      const status: ExecutionStatus = exitCode === 0 ? 'SUCCESS' : 'RUNTIME_ERROR';
      finish({
        status,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: exitCode ?? 1,
      });
    });
  });
}

function cleanupFile(p: string) {
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {}
}
