import z from "zod";
import { amountString } from "../common/amount-schema.validator";

export const disputeAcceptSchema = z.object({
  disputeId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
  allowOverdraft: z.boolean().default(false),
})
export type DisputeAcceptDto = z.infer<typeof disputeAcceptSchema>;
