import { AppError } from './appError';

/**
 * HTTP client for the AI service (ai-service/).
 *
 * The AI service answers `{ success: true, data }` or `{ success: false, error }`.
 * This client unwraps that envelope and turns failures into AppErrors with a status the
 * frontend can act on:
 *   - 503  AI service unreachable (not running / network)
 *   - 504  AI service did not answer within the timeout
 *   - 502  AI service answered with an error or an unreadable response
 *   - 4xx  AI service rejected the request (bad input) — never retried
 *
 * Only transient failures are retried (network errors, 502/503/504). A plain 500 is NOT
 * retried: the AI service already retries model calls and validates their output, so
 * retrying here would multiply waiting time (its calls are spaced >= 8s apart).
 */

export interface AiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Injectable for tests */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiCallResult<T> {
  data: T;
  attempts: number;
  latencyMs: number;
}

/** Thrown after a call has failed; carries the attempt count for monitoring. */
export class AiCallError extends AppError {
  public attempts: number;
  public latencyMs: number;

  constructor(message: string, statusCode: number, attempts: number, latencyMs: number) {
    super(message, statusCode);
    this.attempts = attempts;
    this.latencyMs = latencyMs;
  }
}

/** Upstream statuses that mean "try again shortly" (gateway/availability problems) */
const RETRYABLE_UPSTREAM_STATUS = new Set([502, 503, 504]);

/** Internal: an AppError that also says whether another attempt makes sense */
class AttemptError extends AppError {
  public retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message, statusCode);
    this.retryable = retryable;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface AiClient {
  post<T>(path: string, body: unknown): Promise<AiCallResult<T>>;
  /** Cheap reachability probe used by the health endpoint */
  ping(timeoutMs?: number): Promise<boolean>;
}

export function createAiClient(options: AiClientOptions): AiClient {
  const baseUrl = trimTrailingSlash(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  async function attemptOnce<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        // Not retried: waiting through a second full timeout would exceed any sane UX budget
        throw new AttemptError(
          `The AI service did not respond within ${Math.round(options.timeoutMs / 1000)}s. Please try again.`,
          504,
          false
        );
      }
      throw new AttemptError('The AI service is unreachable. Make sure ai-service is running (AI_SERVICE_URL).', 503, true);
    }

    let payload: any;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      clearTimeout(timer);
      throw new AttemptError('The AI service returned an unreadable response.', 502, false);
    }
    clearTimeout(timer);

    if (response.ok && payload && payload.success !== false) {
      // The AI service wraps results in { success, data }; tolerate a bare object too
      return (payload.data ?? payload) as T;
    }

    const upstreamMessage: string =
      (payload && (payload.error || payload.message)) || `AI service request failed (${response.status})`;

    if (response.status >= 400 && response.status < 500) {
      // Bad input on the AI side: surface as-is, do not retry. (A 404 means the route is missing,
      // i.e. a wrong AI_SERVICE_URL — that is our problem, not the caller's, so report a bad gateway.)
      throw new AttemptError(upstreamMessage, response.status === 404 ? 502 : response.status, false);
    }
    if (RETRYABLE_UPSTREAM_STATUS.has(response.status)) {
      throw new AttemptError(upstreamMessage, response.status, true);
    }
    // Plain 500: the AI service already retried the model call itself
    throw new AttemptError(`AI service error: ${upstreamMessage}`, 502, false);
  }

  return {
    async post<T>(path: string, body: unknown): Promise<AiCallResult<T>> {
      const started = Date.now();
      let attempts = 0;
      let lastError: AttemptError | null = null;

      while (attempts <= options.maxRetries) {
        attempts += 1;
        try {
          const data = await attemptOnce<T>(path, body);
          return { data, attempts, latencyMs: Date.now() - started };
        } catch (err: any) {
          lastError =
            err instanceof AttemptError ? err : new AttemptError(String(err?.message || err), 502, false);
          if (!lastError.retryable || attempts > options.maxRetries) break;
          await sleep(400 * attempts);
        }
      }

      const finalError = lastError ?? new AppError('AI service call failed', 502);
      throw new AiCallError(finalError.message, finalError.statusCode, attempts, Date.now() - started);
    },

    async ping(timeoutMs = 2000): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${baseUrl}/`, { method: 'GET', signal: controller.signal });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
