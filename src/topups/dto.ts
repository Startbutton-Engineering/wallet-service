import z from "zod";
import { amountString } from "../common/amount-schema.validator";

export const topupSchema = z.object({
  topupId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
})
export type TopupDto = z.infer<typeof topupSchema>;
