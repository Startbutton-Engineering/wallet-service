import z from "zod";
import { amountString } from "../common/amount-schema.validator";

export const collectionSchema = z.object({
  collectionId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString
})
export type CollectionDto = z.infer<typeof collectionSchema>;

export const collectionBatchSchema = z.object({
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  items: z.array(z.object({
    collectionId: z.string().min(1),
    amount: amountString,
  }))
    .min(1)
    .max(1000)
    .refine(
      (items) => new Set(items.map((i) => i.collectionId)).size === items.length,
      { message: 'duplicate collectionId in batch' },
    ),
})
export type CollectionBatchDto = z.infer<typeof collectionBatchSchema>;