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
