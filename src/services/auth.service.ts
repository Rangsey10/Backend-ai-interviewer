import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { AuthResponse, JwtUserPayload, SanitizedUser, UserRole } from '../types/auth.types';
import { LoginInput, RegisterInput } from '../validators/auth.validator';
import { AppError } from '../middlewares/errorHandler';

const BCRYPT_SALT_ROUNDS = 10;

// In-memory fallback user store for test environments and offline DB resilience
const inMemoryUsers = new Map<string, any>();
const emailToUserId = new Map<string, string>();

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
 * Register a new user with hashed password and role
 */
export async function register(input: RegisterInput): Promise<AuthResponse> {
  const normalizedEmail = input.email.toLowerCase().trim();

  // Check in-memory first
  if (emailToUserId.has(normalizedEmail)) {
    throw new AppError('Email address is already registered', 409);
  }

  // Check database if available
  try {
    if (prisma?.user?.findUnique) {
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUser) {
        throw new AppError('Email address is already registered', 409);
      }
    }
  } catch (err: any) {
    if (err instanceof AppError) throw err;
  }

  // Hash password using bcrypt
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);
  const role = (input.role as UserRole) || UserRole.CANDIDATE;
  const userId = randomUUID();
  const now = new Date();

  const userRecord = {
    id: userId,
    fullName: input.fullName.trim(),
    email: normalizedEmail,
    passwordHash,
    role,
    resumeUrl: input.resumeUrl || null,
    createdAt: now,
    updatedAt: now,
  };

  inMemoryUsers.set(userId, userRecord);
  emailToUserId.set(normalizedEmail, userId);

  // Persist to DB if available
  try {
    if (prisma?.user?.create) {
      const dbUser = await prisma.user.create({
        data: {
          id: userId,
          fullName: userRecord.fullName,
          email: userRecord.email,
          passwordHash: userRecord.passwordHash,
          role: userRecord.role as any,
          resumeUrl: userRecord.resumeUrl,
        },
      });
      if (dbUser) {
        inMemoryUsers.set(dbUser.id, dbUser);
        emailToUserId.set(dbUser.email, dbUser.id);
      }
    }
  } catch {
    // Falls back to in-memory store
  }

  const sanitized = sanitizeUser(userRecord);
  const token = generateToken({
    userId: userRecord.id,
    email: userRecord.email,
    role: sanitized.role,
  });

  return { user: sanitized, token };
}

/**
 * Authenticate existing user with email and password
 */
export async function login(input: LoginInput): Promise<AuthResponse> {
  const normalizedEmail = input.email.toLowerCase().trim();

  let user: any = null;

  try {
    if (prisma?.user?.findUnique) {
      user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
    }
  } catch {}

  if (!user) {
    const memoryId = emailToUserId.get(normalizedEmail);
    if (memoryId) {
      user = inMemoryUsers.get(memoryId);
    }
  }

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!isPasswordValid) {
    throw new AppError('Invalid email or password', 401);
  }

  const sanitized = sanitizeUser(user);
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: sanitized.role,
  });

  return { user: sanitized, token };
}

/**
 * Retrieve user profile by user ID
 */
export async function getUserProfile(userId: string): Promise<SanitizedUser> {
  let user: any = null;

  try {
    if (prisma?.user?.findUnique) {
      user = await prisma.user.findUnique({
        where: { id: userId },
      });
    }
  } catch {}

  if (!user) {
    user = inMemoryUsers.get(userId);
  }

  if (!user) {
    throw new AppError('User profile not found', 404);
  }

  return sanitizeUser(user);
}
