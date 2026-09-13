import z from "zod";
import { amountString } from "../common/amount-schema.validator";

export const collectionSchema = z.object({
  collectionId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString
})
export type CollectionDto = z.infer<typeof collectionSchema>;