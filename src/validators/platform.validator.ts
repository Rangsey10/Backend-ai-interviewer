import { z } from 'zod';

export const adminUpdateUserSchema = z
  .object({
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
    role: z.enum(['CANDIDATE', 'RECRUITER', 'ADMIN']).optional(),
  })
  .refine((v) => v.status !== undefined || v.role !== undefined, { message: 'Provide status and/or role' });

export const listUsersQuerySchema = z.object({
  role: z.enum(['CANDIDATE', 'RECRUITER', 'ADMIN']).optional(),
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
  q: z.string().max(100).optional(),
});

export const updateProfileSchema = z
  .object({
    fullName: z.string().min(2).max(100).trim().optional(),
    resumeUrl: z.string().url('Invalid URL format for resume').nullable().optional(),
  })
  .refine((v) => v.fullName !== undefined || v.resumeUrl !== undefined, { message: 'Nothing to update' });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(100),
});

export const compareSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(2, 'Select at least two interviews').max(10),
});

export const notificationsQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
