import z from "zod";
import { amountString } from "../common/amount-schema.validator";
import { PAYOUT_STATUSES } from "./payout-transitions";

export const payoutStatusSchema = z.object({
  payoutId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
  status: z.enum(PAYOUT_STATUSES),
})
export type PayoutStatusDto = z.infer<typeof payoutStatusSchema>;

