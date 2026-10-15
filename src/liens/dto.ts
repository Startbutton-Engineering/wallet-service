import z from "zod";
import { amountString } from "../common/amount-schema.validator";
import { WALLET_TYPES } from "../accounts/account";

export const lienSchema = z.object({
  lienId: z.string().min(1),
  ownerId: z.string().min(1),
  walletType: z.enum(WALLET_TYPES),
  currency: z.string().min(1),
  amount: amountString,
})
export type LienDto = z.infer<typeof lienSchema>;
