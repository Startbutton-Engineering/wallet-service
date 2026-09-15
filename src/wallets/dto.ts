import z from "zod";

export const createWalletSchema = z.object({
  ownerId: z.string().min(1),
  currency: z.string().min(1),
});
export type CreateWalletDto = z.infer<typeof createWalletSchema>;

export interface WalletBalance {
  tenantId: string;
  ownerId: string;
  currency: string;
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
    available: bal.available.toString(),
    heldInflow: bal.heldInflow.toString(),
    heldOutflow: bal.heldOutflow.toString(),
    reserve: bal.reserve.toString(),
    ledger: bal.ledger.toString(),
    refundChargeback: bal.refundChargeback.toString() 
  }
}