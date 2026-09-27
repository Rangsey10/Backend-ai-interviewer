import { z } from 'zod';

export const executeCodeSchema = z.object({
  language: z
    .string()
    .min(1, 'language cannot be empty')
    .toLowerCase()
    .trim(),
  code: z
    .string()
    .min(1, 'code cannot be empty')
    .max(100_000, 'code cannot exceed 100,000 characters'),
  timeoutMs: z
    .number()
    .int()
    .min(500, 'timeoutMs must be at least 500ms')
    .max(30000, 'timeoutMs cannot exceed 30000ms (30s)')
    .optional()
    .default(5000),
  testCases: z
    .array(
      z.object({
        input: z.any().optional(),
        expectedOutput: z.any().optional(),
        description: z.string().optional(),
      })
    )
    .optional(),
});

export type ExecuteCodeSchemaInput = z.infer<typeof executeCodeSchema>;
