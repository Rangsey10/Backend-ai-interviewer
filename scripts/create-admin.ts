/**
 * Creates an ADMIN user (or promotes an existing user to ADMIN).
 * Public registration cannot create admins, so use this instead.
 *
 * Usage:
 *   npm run create-admin -- <email> <password> "<Full Name>"
 *
 * Requires DATABASE_URL (in-memory mode has no persistent users to promote).
 */
import bcrypt from 'bcrypt';
import { prisma } from '../src/config/db';

async function main() {
  const [email, password, fullName = 'Administrator'] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password> "<Full Name>"');
    process.exit(1);
  }
  if (!prisma) {
    console.error('DATABASE_URL is not set. Admins can only be created in a real database.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email: normalizedEmail },
    update: { role: 'ADMIN', passwordHash },
    create: { email: normalizedEmail, fullName, passwordHash, role: 'ADMIN' },
  });

  console.log(`✔ ${user.email} is now an ADMIN (id: ${user.id})`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
