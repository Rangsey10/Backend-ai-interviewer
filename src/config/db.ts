/* eslint-disable @typescript-eslint/no-var-requires */
let PrismaClientClass: any;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  PrismaClientClass = require('@prisma/client').PrismaClient;
} catch {
  PrismaClientClass = class MockPrismaClient {
    user = {
      findUnique: async () => null,
      create: async (args: any) => ({ id: 'mock-user-id', ...args.data, createdAt: new Date(), updatedAt: new Date() }),
    };
    interviewSession = {
      findUnique: async () => null,
      create: async (args: any) => ({ id: 'mock-session-id', ...args.data, createdAt: new Date(), updatedAt: new Date() }),
      update: async (args: any) => ({ id: args.where.id, ...args.data, updatedAt: new Date() }),
    };
  };
}

let prisma: any;

try {
  if (process.env.NODE_ENV === 'production') {
    prisma = new PrismaClientClass();
  } else {
    if (!(global as any).__prisma) {
      (global as any).__prisma = new PrismaClientClass({
        log: ['error', 'warn'],
      });
    }
    prisma = (global as any).__prisma;
  }
} catch {
  prisma = new PrismaClientClass();
}

export { prisma };
export default prisma;
