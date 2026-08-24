export type ExecutionStatus = 'SUCCESS' | 'RUNTIME_ERROR' | 'TIMEOUT';

export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'js' | 'ts' | 'py';

export interface TestCase {
  input?: any;
  expectedOutput?: any;
  description?: string;
}

export interface TestCaseResult {
  testIndex: number;
  description?: string;
  passed: boolean;
  input?: any;
  expected?: any;
  actual?: any;
  error?: string;
}

export interface ExecuteCodeInput {
  language: string;
  code: string;
  testCases?: TestCase[];
  timeoutMs?: number;
}

export interface CodeExecutionResult {
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  exitCode: number;
  runnerMode?: 'DOCKER' | 'ISOLATED_PROCESS';
  testResults?: TestCaseResult[];
}
