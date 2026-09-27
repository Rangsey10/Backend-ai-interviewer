import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Only needed for `prisma migrate` / `prisma studio`; `prisma generate` works without it
    url: process.env.DATABASE_URL ?? '',
  },
});
