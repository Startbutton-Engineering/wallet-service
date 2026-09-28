import z from "zod";
import { amountString } from "../common/amount-schema.validator";
import { WALLET_TYPES } from "../accounts/account";

export const rateString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, { error: 'rate must be a positive decimal string', abort: true })
  .refine((s) => Number(s) > 0, 'rate must be positive');

export const initiateConversionSchema = z
  .object({
    conversionId: z.string().min(1),
    ownerId: z.string().min(1),
    fromCurrency: z.string().min(1),
    toCurrency: z.string().min(1),
    fromAmount: amountString,
    rate: rateString,
    walletType: z.enum(WALLET_TYPES).default('collection'),
  })
  .refine((body) => body.fromCurrency !== body.toCurrency, {
    message: 'fromCurrency and toCurrency must be different',
    path: ['toCurrency'],
  });
export type InitiateConversionDto = z.infer<typeof initiateConversionSchema>;

export const resolveConversionSchema = z.object({
  conversionId: z.string().min(1),
  ownerId: z.string().min(1),
  fromCurrency: z.string().min(1),
  toCurrency: z.string().min(1),
  walletType: z.enum(WALLET_TYPES).default('collection'),
});
export type ResolveConversionDto = z.infer<typeof resolveConversionSchema>;

export const listPendingConversionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListPendingConversionsDto = z.infer<typeof listPendingConversionsSchema>;
