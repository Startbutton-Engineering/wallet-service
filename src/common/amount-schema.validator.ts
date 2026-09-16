import z from "zod";

export const amountString = z
  .string()
  // `abort` stops the pipeline at a failed regex. Without it zod still runs the refine
  // below, where BigInt() throws a raw SyntaxError on a non-numeric string — and that
  // escapes ZodValidationPipe as a 500 instead of the 400 it should be.
  .regex(/^\d+$/, {
    error: 'amount must be a non-negative integer string of minor units',
    abort: true,
  })
  .refine((s) => BigInt(s) > 0n, 'amount must be positive')
