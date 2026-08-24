import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeExecutionResult, ExecuteCodeInput, ExecutionStatus } from '../types/codeRunner.types';

const DOCKER_IMAGE = process.env.RUNNER_DOCKER_IMAGE || 'interviewai-runner:latest';
const DEFAULT_TIMEOUT_MS = 5000;

// Cache Docker availability check
let isDockerAvailableCache: boolean | null = null;

/**
 * Checks if Docker CLI and daemon are operational
 */
export function isDockerAvailable(): boolean {
  if (isDockerAvailableCache !== null) {
    return isDockerAvailableCache;
  }

  try {
    execSync('docker info', { stdio: 'ignore', timeout: 1500 });
    isDockerAvailableCache = true;
  } catch {
    isDockerAvailableCache = false;
  }

  return isDockerAvailableCache;
}

/**
 * Normalizes programming language string
 */
export function normalizeLanguage(lang: string): 'javascript' | 'typescript' | 'python' {
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
  return 'javascript';
}

/**
 * Main Sandboxed Code Execution Entrypoint
 */
export async function executeCode(input: ExecuteCodeInput): Promise<CodeExecutionResult> {
  const language = normalizeLanguage(input.language);
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const code = input.code || '';

  const dockerActive = isDockerAvailable();

  if (dockerActive) {
    return runInDockerSandbox(language, code, timeoutMs);
  } else {
    // Graceful fallback to isolated child process if Docker daemon is not running locally
    return runInIsolatedProcess(language, code, timeoutMs);
  }
}

/**
 * Runs code inside an isolated, ephemeral Docker container
 * Security constraints:
 *   - --rm (Ephemeral auto-cleanup)
 *   - --network none (Zero outbound network access)
 *   - --memory="128m" (RAM cap)
 *   - --cpus="0.5" (CPU throttle)
 *   - --pids-limit 64 (Fork-bomb protection)
 *   - --security-opt no-new-privileges (Privilege escalation block)
 *   - Non-root user execution
 */
async function runInDockerSandbox(
  language: 'javascript' | 'typescript' | 'python',
  code: string,
  timeoutMs: number
): Promise<CodeExecutionResult> {
  const startTime = Date.now();
  const base64Code = Buffer.from(code, 'utf8').toString('base64');

  let scriptCmd = '';
  if (language === 'python') {
    scriptCmd = `printf '%s' "${base64Code}" | base64 -d > /tmp/main.py && python3 /tmp/main.py`;
  } else {
    // javascript / typescript
    scriptCmd = `printf '%s' "${base64Code}" | base64 -d > /tmp/main.js && node /tmp/main.js`;
  }

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--network', 'none',
    '--memory', '128m',
    '--cpus', '0.5',
    '--pids-limit', '64',
    '--security-opt', 'no-new-privileges',
    DOCKER_IMAGE,
    'sh', '-c', scriptCmd,
  ];

  return new Promise<CodeExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const executionTimeMs = Date.now() - startTime;
      resolve({
        status: 'RUNTIME_ERROR',
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        executionTimeMs,
        exitCode: 1,
        runnerMode: 'DOCKER',
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const executionTimeMs = Date.now() - startTime;

      if (timedOut) {
        return resolve({
          status: 'TIMEOUT',
          stdout,
          stderr: `Execution timed out after ${timeoutMs}ms`,
          executionTimeMs,
          exitCode: 124,
          runnerMode: 'DOCKER',
        });
      }

      const status: ExecutionStatus =
        exitCode === 0 && !stderr.includes('Traceback (most recent call last)') && !stderr.includes('Error:')
          ? 'SUCCESS'
          : 'RUNTIME_ERROR';

      resolve({
        status,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        executionTimeMs,
        exitCode: exitCode ?? 0,
        runnerMode: 'DOCKER',
      });
    });
  });
}

/**
 * Isolated process execution fallback when Docker daemon is not active locally
 * Still enforces strict timeouts and file separation
 */
async function runInIsolatedProcess(
  language: 'javascript' | 'typescript' | 'python',
  code: string,
  timeoutMs: number
): Promise<CodeExecutionResult> {
  const startTime = Date.now();
  const tmpDir = os.tmpdir();
  const fileId = randomUUID();
  const ext = language === 'python' ? 'py' : 'js';
  const filePath = path.join(tmpDir, `interviewai_${fileId}.${ext}`);

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

  let cmd = 'node';
  let args = [filePath];

  if (language === 'python') {
    // Try python or python3
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    args = [filePath];
  }

  return new Promise<CodeExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(cmd, args, {
      cwd: tmpDir,
      env: {
        NODE_ENV: 'production',
        PATH: process.env.PATH,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanupFile(filePath);
      const executionTimeMs = Date.now() - startTime;
      resolve({
        status: 'RUNTIME_ERROR',
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        executionTimeMs,
        exitCode: 1,
        runnerMode: 'ISOLATED_PROCESS',
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      cleanupFile(filePath);
      const executionTimeMs = Date.now() - startTime;

      if (timedOut) {
        return resolve({
          status: 'TIMEOUT',
          stdout,
          stderr: `Execution timed out after ${timeoutMs}ms`,
          executionTimeMs,
          exitCode: 124,
          runnerMode: 'ISOLATED_PROCESS',
        });
      }

      const hasError =
        exitCode !== 0 ||
        stderr.includes('SyntaxError') ||
        stderr.includes('TypeError') ||
        stderr.includes('ReferenceError') ||
        stderr.includes('ZeroDivisionError') ||
        stderr.includes('Traceback (most recent call last)');

      const status: ExecutionStatus = hasError ? 'RUNTIME_ERROR' : 'SUCCESS';

      resolve({
        status,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        executionTimeMs,
        exitCode: exitCode ?? 0,
        runnerMode: 'ISOLATED_PROCESS',
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
