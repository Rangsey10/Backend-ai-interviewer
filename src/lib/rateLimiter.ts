/**
 * Sliding-window rate limiter keyed by user. In-memory (single server process), which is
 * what protects the shared Groq quota behind the AI service in this deployment.
 */
export interface RateLimiter {
  /** Records a hit; returns whether it is allowed and, if not, seconds until the next slot */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(limit: number, windowMs: number = 60_000, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    hit(key: string) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);

      if (recent.length >= limit) {
        hits.set(key, recent);
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
        return { allowed: false, retryAfterSeconds };
      }

      recent.push(t);
      hits.set(key, recent);

      // Opportunistic cleanup so idle users don't accumulate forever
      if (hits.size > 5000) {
        for (const [k, v] of hits) {
          if (v.length === 0 || t - v[v.length - 1] >= windowMs) hits.delete(k);
        }
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
