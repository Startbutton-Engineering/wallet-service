import z from "zod";
import { amountString } from "../common/amount-schema.validator";
import { WALLET_TYPES } from "../accounts/account";

export const initiateSettlementSchema = z.object({
  settlementId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
  walletType: z.enum(WALLET_TYPES).default('collection'),
});
export type InitiateSettlementDto = z.infer<typeof initiateSettlementSchema>;

export const resolveSettlementSchema = z.object({
  settlementId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  walletType: z.enum(WALLET_TYPES).default('collection'),
});
export type ResolveSettlementDto = z.infer<typeof resolveSettlementSchema>;

export const listPendingSettlementsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListPendingSettlementsDto = z.infer<typeof listPendingSettlementsSchema>;
