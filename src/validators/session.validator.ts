import { z } from 'zod';
import { SessionStatus } from '../types/session.types';

export const createSessionSchema = z.object({
  jobTitle: z
    .string()
    .min(2, 'jobTitle must be at least 2 characters')
    .max(200, 'jobTitle cannot exceed 200 characters')
    .trim(),
  candidateId: z.string().optional(),
  recruiterId: z.string().optional(),
  jobDescription: z.string().optional().nullable(),
  resumeText: z.string().optional().nullable(),
  initialCode: z.string().optional().nullable(),
  status: z.enum([SessionStatus.SCHEDULED, SessionStatus.ACTIVE, SessionStatus.COMPLETED]).optional().default(SessionStatus.SCHEDULED),
});

export const updateSessionStatusSchema = z.object({
  status: z.enum([SessionStatus.SCHEDULED, SessionStatus.ACTIVE, SessionStatus.COMPLETED]),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionStatusInput = z.infer<typeof updateSessionStatusSchema>;
