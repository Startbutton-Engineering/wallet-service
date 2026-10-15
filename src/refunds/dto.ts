import z from "zod";
import { amountString } from "../common/amount-schema.validator";
import { REFUND_STATUSES } from "./refund-transitions";
import { REFUND_FEE_STATUSES } from "./refund-fee-transitions";

export const refundStatusSchema = z.object({
  refundId: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
  status: z.enum(REFUND_STATUSES),
  allowOverdraft: z.boolean().default(false),
})
export type RefundStatusDto = z.infer<typeof refundStatusSchema>;

export const refundFeeStatusSchema = z.object({
  refundId: z.string().min(1),
  /** The bank transfer paying the refund out; the fee's postings are filed under it. */
  transferReference: z.string().min(1),
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  amount: amountString,
  status: z.enum(REFUND_FEE_STATUSES),
})
export type RefundFeeStatusDto = z.infer<typeof refundFeeStatusSchema>;
