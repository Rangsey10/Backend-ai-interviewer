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
  resumeUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
    return prisma.user.create({ data: { ...data, role: data.role as UserRole } });
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
  resumeUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SanitizedUser {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role as UserRole,
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
    resumeUrl: input.resumeUrl || null,
  });

  const sanitized = sanitizeUser(user);
  const token = generateToken({ userId: user.id, email: user.email, role: sanitized.role });

  return { user: sanitized, token };
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
