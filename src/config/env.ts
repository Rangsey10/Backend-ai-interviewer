import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const envSchema = z
  .object({
    PORT: z.string().default('5000'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    // No default: a known fallback secret would let anyone forge tokens
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be set and at least 32 characters long'),
    JWT_EXPIRES_IN: z.string().default('7d'),
    // Comma-separated list of allowed origins, or "*"
    CORS_ORIGIN: z.string().default('*'),
    DATABASE_URL: z.string().optional(),
    // AI service (ai-service/): question generation, answer feedback, code evaluation, final report
    AI_SERVICE_URL: z.string().default('http://localhost:3000'),
    // The AI service queues calls (>= 8s apart) and evaluates code in Docker, so allow a long timeout
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
    // Extra attempts for network errors / 502-504 only (the AI service already retries model calls itself)
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    // Max AI requests per user per minute (protects the shared Groq rate limit)
    AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
    // In-memory mode only (no DATABASE_URL): create this admin at startup so the admin workspace can be demoed.
    // With a database use `npm run create-admin` instead.
    DEV_ADMIN_EMAIL: z.string().email().optional(),
    DEV_ADMIN_PASSWORD: z.string().min(8).optional(),
    // Allows running candidate code directly on the host when Docker is unavailable (never in production)
    ALLOW_UNSANDBOXED_RUNNER: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL is required in production' });
    }
    if (cfg.NODE_ENV === 'production' && cfg.ALLOW_UNSANDBOXED_RUNNER) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_UNSANDBOXED_RUNNER'],
        message: 'Unsandboxed code execution cannot be enabled in production',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`❌ Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigin: string | string[] =
  env.CORS_ORIGIN.trim() === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
