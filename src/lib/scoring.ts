/**
 * Score helpers. The AI service uses different scales per feature:
 *   AI-006 answer feedback  -> 0-10
 *   AI-005 code evaluation  -> 0-100
 *   AI-007 final report     -> 0-100
 * Analytics always works on 0-100.
 */

export type Recommendation = 'Strong Hire' | 'Hire' | 'Lean Hire' | 'No Hire' | 'Strong No Hire';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** AI-006 feedback score (0-10) -> 0-100 */
export function feedbackScoreTo100(score: unknown): number | null {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return round1(clamp(n, 0, 10) * 10);
}

/** AI-005 code evaluation score is already 0-100 */
export function codeScoreTo100(score: unknown): number | null {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return round1(clamp(n, 0, 100));
}

export function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return round1(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** Nearest-rank percentile (p in 0-100) of a list of numbers, or null when empty */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Normalised 0-100 score for one stored answer (code answers use the code evaluation) */
export function scoreForAnswer(input: { feedback?: any; codeEvaluation?: any }): number | null {
  if (input.codeEvaluation && input.codeEvaluation.score !== undefined) {
    return codeScoreTo100(input.codeEvaluation.score);
  }
  if (input.feedback && input.feedback.score !== undefined) {
    return feedbackScoreTo100(input.feedback.score);
  }
  return null;
}

const RECOMMENDATION_RANK: Record<string, number> = {
  'Strong Hire': 5,
  Hire: 4,
  'Lean Hire': 3,
  'No Hire': 2,
  'Strong No Hire': 1,
};

/** 5 (best) .. 1 (worst); 0 when unknown — used to sort candidates */
export function recommendationRank(recommendation: string | null | undefined): number {
  return (recommendation && RECOMMENDATION_RANK[recommendation]) || 0;
}
