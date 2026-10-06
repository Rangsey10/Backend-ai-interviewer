import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { AuthResponse, JwtUserPayload, SanitizedUser, UserRole } from '../types/auth.types';
import { LoginInput, RegisterInput } from '../validators/auth.validator';
import { AppError } from '../middlewares/errorHandler';

const BCRYPT_SALT_ROUNDS = 10;

interface UserRecord {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  role: string;
  status: string;
  resumeUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
const USER_STATUSES: UserStatus[] = ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED'];

// In-memory user store, used ONLY when no DATABASE_URL is configured (dev/test)
const inMemoryUsers = new Map<string, UserRecord>();
const emailToUserId = new Map<string, string>();

async function findUserByEmail(email: string): Promise<UserRecord | null> {
  if (prisma) {
    return prisma.user.findUnique({ where: { email } });
  }
  const id = emailToUserId.get(email);
  return id ? inMemoryUsers.get(id) ?? null : null;
}

async function findUserById(id: string): Promise<UserRecord | null> {
  if (prisma) {
    return prisma.user.findUnique({ where: { id } });
  }
  return inMemoryUsers.get(id) ?? null;
}

async function insertUser(data: Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<UserRecord> {
  if (prisma) {
    return prisma.user.create({ data: { ...data, role: data.role as UserRole, status: data.status as UserStatus } });
  }
  const now = new Date();
  const record: UserRecord = { id: randomUUID(), ...data, createdAt: now, updatedAt: now };
  inMemoryUsers.set(record.id, record);
  emailToUserId.set(record.email, record.id);
  return record;
}

/**
 * Strips sensitive data (passwordHash) from user object
 */
export function sanitizeUser(user: {
  id: string;
  fullName: string;
  email: string;
  role: string | UserRole;
  status?: string;
  resumeUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SanitizedUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role as UserRole,
    status: (user.status as UserStatus) ?? 'ACTIVE',
    resumeUrl: user.resumeUrl,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Generates signed JWT for authenticated user
 */
export function generateToken(payload: { userId: string; email: string; role: UserRole }): string {
  const tokenPayload: JwtUserPayload = {
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
  };

  return jwt.sign(tokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
  });
}

/**
 * Register a new user with hashed password and role.
 * Public registration is limited to CANDIDATE / RECRUITER by the validator.
 */
export async function register(input: RegisterInput): Promise<AuthResponse> {
  const normalizedEmail = input.email.toLowerCase().trim();

  if (await findUserByEmail(normalizedEmail)) {
    throw new AppError('Email address is already registered', 409);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);
  const user = await insertUser({
    fullName: input.fullName.trim(),
    email: normalizedEmail,
    passwordHash,
    role: input.role,
    // Recruiters can see candidate data, so an admin must approve them first
    status: input.role === UserRole.RECRUITER ? 'PENDING_APPROVAL' : 'ACTIVE',
    resumeUrl: input.resumeUrl || null,
  });

  const sanitized = sanitizeUser(user);
  if (sanitized.status === 'PENDING_APPROVAL') {
    return { user: sanitized, token: null, pendingApproval: true };
  }
  const token = generateToken({ userId: user.id, email: user.email, role: sanitized.role });

  return { user: sanitized, token };
}

const STATUS_MESSAGES: Record<string, string> = {
  PENDING_APPROVAL: 'Your recruiter account is waiting for administrator approval.',
  REJECTED: 'Your account request was not approved.',
  SUSPENDED: 'Your account has been suspended. Contact an administrator.',
};

function assertCanSignIn(user: { status?: string }): void {
  const status = user.status ?? 'ACTIVE';
  if (status !== 'ACTIVE') {
    throw new AppError(STATUS_MESSAGES[status] ?? 'Your account is not active.', 403);
  }
}

/**
 * Authenticate existing user with email and password
 */
export async function login(input: LoginInput): Promise<AuthResponse> {
  const normalizedEmail = input.email.toLowerCase().trim();
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!isPasswordValid) {
    throw new AppError('Invalid email or password', 401);
  }
  assertCanSignIn(user);

  const sanitized = sanitizeUser(user);
  const token = generateToken({ userId: user.id, email: user.email, role: sanitized.role });

  return { user: sanitized, token };
}

/**
 * Retrieve user profile by user ID
 */
export async function getUserProfile(userId: string): Promise<SanitizedUser> {
  const user = await findUserById(userId);

  if (!user) {
    throw new AppError('User profile not found', 404);
  }

  return sanitizeUser(user);
}

/* ------------------------------------------------------------------ account management */

// Short-lived cache so requireAuth can enforce suspension without a DB hit per request
const statusCache = new Map<string, { status: string; at: number }>();
const STATUS_CACHE_MS = 15_000;

/** Current account status; unknown users report null (token for a deleted account) */
export async function getUserStatus(userId: string): Promise<string | null> {
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < STATUS_CACHE_MS) return hit.status;
  const user = await findUserById(userId);
  if (!user) return null;
  statusCache.set(userId, { status: user.status ?? 'ACTIVE', at: Date.now() });
  return user.status ?? 'ACTIVE';
}

export async function listUsers(filter: { role?: string; status?: string; q?: string } = {}): Promise<SanitizedUser[]> {
  let rows: UserRecord[];
  if (prisma) {
    rows = await prisma.user.findMany({
      where: {
        ...(filter.role ? { role: filter.role as UserRole } : {}),
        ...(filter.status ? { status: filter.status as UserStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  } else {
    rows = [...inMemoryUsers.values()]
      .filter((u) => (!filter.role || u.role === filter.role) && (!filter.status || (u.status ?? 'ACTIVE') === filter.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  const q = filter.q?.trim().toLowerCase();
  return rows
    .filter((u) => !q || u.fullName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .map(sanitizeUser);
}

export async function userStats(): Promise<{ total: number; byRole: Record<string, number>; pendingApproval: number }> {
  const users = await listUsers();
  const byRole: Record<string, number> = {};
  for (const u of users) byRole[u.role] = (byRole[u.role] ?? 0) + 1;
  return { total: users.length, byRole, pendingApproval: users.filter((u) => u.status === 'PENDING_APPROVAL').length };
}

/** Name/email lookup used to label sessions in in-memory mode */
export async function lookupUsers(ids: string[]): Promise<Map<string, { id: string; fullName: string; email: string }>> {
  const out = new Map<string, { id: string; fullName: string; email: string }>();
  for (const id of new Set(ids.filter(Boolean))) {
    const u = await findUserById(id);
    if (u) out.set(id, { id: u.id, fullName: u.fullName, email: u.email });
  }
  return out;
}

/** Admin: approve / reject / suspend an account, or change its role */
export async function adminUpdateUser(
  actorId: string,
  userId: string,
  changes: { status?: UserStatus; role?: UserRole }
): Promise<SanitizedUser> {
  if (changes.status && !USER_STATUSES.includes(changes.status)) throw new AppError('Invalid status', 400);
  if (userId === actorId && (changes.status || changes.role)) {
    throw new AppError('You cannot change your own role or status', 400);
  }
  const user = await findUserById(userId);
  if (!user) throw new AppError('User not found', 404);

  const data: { status?: UserStatus; role?: UserRole } = {};
  if (changes.status) data.status = changes.status;
  if (changes.role) data.role = changes.role;

  let updated: UserRecord;
  if (prisma) {
    updated = await prisma.user.update({ where: { id: userId }, data });
  } else {
    updated = { ...user, ...data, updatedAt: new Date() } as UserRecord;
    inMemoryUsers.set(userId, updated);
  }
  statusCache.delete(userId);
  return sanitizeUser(updated);
}

export async function updateProfile(
  userId: string,
  changes: { fullName?: string; resumeUrl?: string | null }
): Promise<SanitizedUser> {
  const user = await findUserById(userId);
  if (!user) throw new AppError('User profile not found', 404);

  const data: { fullName?: string; resumeUrl?: string | null } = {};
  if (changes.fullName !== undefined) data.fullName = changes.fullName.trim();
  if (changes.resumeUrl !== undefined) data.resumeUrl = changes.resumeUrl;

  let updated: UserRecord;
  if (prisma) {
    updated = await prisma.user.update({ where: { id: userId }, data });
  } else {
    updated = { ...user, ...data, updatedAt: new Date() };
    inMemoryUsers.set(userId, updated);
  }
  return sanitizeUser(updated);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new AppError('User profile not found', 404);
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError('Current password is incorrect', 400);
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
  if (prisma) {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  } else {
    inMemoryUsers.set(userId, { ...user, passwordHash, updatedAt: new Date() });
  }
}

/** Resolves an account by email (used to assign an interview to a candidate) */
export async function findAccountByEmail(email: string): Promise<{ id: string; role: string; fullName: string } | null> {
  const user = await findUserByEmail(email.toLowerCase().trim());
  return user ? { id: user.id, role: user.role, fullName: user.fullName } : null;
}

/** In-memory (no DATABASE_URL) mode only: creates the DEV_ADMIN_* account so the admin workspace can be demoed */
export async function seedDevAdmin(): Promise<void> {
  if (prisma || !env.DEV_ADMIN_EMAIL || !env.DEV_ADMIN_PASSWORD) return;
  const email = env.DEV_ADMIN_EMAIL.toLowerCase().trim();
  if (await findUserByEmail(email)) return;
  await insertUser({
    fullName: 'Administrator',
    email,
    passwordHash: await bcrypt.hash(env.DEV_ADMIN_PASSWORD, BCRYPT_SALT_ROUNDS),
    role: UserRole.ADMIN,
    status: 'ACTIVE',
    resumeUrl: null,
  });
  console.log(`🔑 Dev admin created in memory: ${email}`);
}
