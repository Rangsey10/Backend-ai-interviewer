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
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password cannot exceed 100 characters'),
  // ADMIN cannot be self-assigned; create admins with `npm run create-admin`
  role: z
    .enum([UserRole.CANDIDATE, UserRole.RECRUITER], {
      error: 'role must be CANDIDATE or RECRUITER',
    })
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
