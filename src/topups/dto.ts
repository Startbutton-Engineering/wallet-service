import z from "zod";
import { signedAmountString } from "../common/amount-schema.validator";

export const topupSchema = z.object({
  topupId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: signedAmountString,
})
export type TopupDto = z.infer<typeof topupSchema>;
