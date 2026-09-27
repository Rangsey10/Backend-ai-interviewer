import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env';

/**
 * Prisma client, or null when DATABASE_URL is not configured.
 *
 * Without a database the services use an in-memory store (development/test only —
 * env.ts refuses to start in production without DATABASE_URL). When a database IS
 * configured, errors propagate instead of silently falling back to memory.
 */
function createClient(): PrismaClient | null {
  if (!env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL not set — using IN-MEMORY storage. All data is lost on restart.');
    return null;
  }

  const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
      log: env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
    });
  }
  return globalForPrisma.__prisma;
}

export const prisma = createClient();
export default prisma;
