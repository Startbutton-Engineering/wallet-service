import z from "zod";

export const amountString = z
  .string()
  .regex(/^\d+$/, 'amount must be a non-negative integer string of minro units')
  .refine((s) => BigInt(s) > 0n, 'amount must be positive')