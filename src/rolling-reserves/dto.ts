import z from "zod";
import { amountString } from "../common/amount-schema.validator";

export const rollingReserveReleaseSchema = z.object({
  releaseId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
})
export type RollingReserveReleaseDto = z.infer<typeof rollingReserveReleaseSchema>;
