import z from "zod";
import { WALLET_TYPES, WalletType } from "../accounts/account";
import { amountString } from "../common/amount-schema.validator";

export const createWalletSchema = z.object({
  ownerId: z.string().min(1),
  currency: z.string().min(1),
  walletType: z.enum(WALLET_TYPES),
});
export type CreateWalletDto = z.infer<typeof createWalletSchema>;

/** Move funds between two of one owner's wallets in the same currency — collection to payout
 * to fund upcoming payouts, or payout back to collection to release unused float. */
export const walletTransferSchema = z
  .object({
    transferId: z.string().min(1),
    ownerId: z.string().min(1),
    currency: z.string().min(1),
    amount: amountString,
    from: z.enum(WALLET_TYPES),
    to: z.enum(WALLET_TYPES),
  })
  .refine((body) => body.from !== body.to, {
    message: 'from and to must be different wallet types',
    path: ['to'],
  });
export type WalletTransferDto = z.infer<typeof walletTransferSchema>;

export interface WalletBalance {
  tenantId: string;
  ownerId: string;
  currency: string;
  walletType: WalletType;
  available: bigint;
  heldInflow: bigint;
  heldOutflow: bigint;
  reserve: bigint;
  ledger: bigint;
  refundChargeback: bigint;
}

export function balanceToJson(bal: WalletBalance) {
  return {
    ownerId: bal.ownerId,
    currency: bal.currency,
    walletType: bal.walletType,
    available: bal.available.toString(),
    heldInflow: bal.heldInflow.toString(),
    heldOutflow: bal.heldOutflow.toString(),
    reserve: bal.reserve.toString(),
    ledger: bal.ledger.toString(),
    refundChargeback: bal.refundChargeback.toString() 
  }
}
