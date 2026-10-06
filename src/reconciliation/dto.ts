import { z } from "zod";

export const ownerReconciliationQuerySchema = z.object({
  currency: z.string().min(1).optional(),
});

export type OwnerReconciliationQueryDto = z.infer<typeof ownerReconciliationQuerySchema>;

export const runHistoryQuerySchema = z.object({
  kind: z.enum(['daily', 'manual', 'owner']).optional(),
  ownerId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export type RunHistoryQueryDto = z.infer<typeof runHistoryQuerySchema>;
