import { z } from 'zod';
import { UserRole } from '../types/auth.types';

export const registerSchema = z.object({
  fullName: z
    .string()
    .min(2, 'Full name must be at least 2 characters')
    .max(100, 'Full name cannot exceed 100 characters')
    .trim(),
  email: z
    .string()
    .email('Invalid email address format')
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters')
    .max(100, 'Password cannot exceed 100 characters'),
  role: z
    .enum([UserRole.CANDIDATE, UserRole.RECRUITER, UserRole.ADMIN])
    .default(UserRole.CANDIDATE),
  resumeUrl: z.string().url('Invalid URL format for resume').optional().nullable(),
});

export const loginSchema = z.object({
  email: z
    .string()
    .email('Invalid email address format')
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(1, 'Password is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
