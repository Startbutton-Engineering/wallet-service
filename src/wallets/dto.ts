import z from "zod";
import { USER_ACCOUNT_TYPES, WALLET_TYPES, WalletType } from "../accounts/account";
import { amountString } from "../common/amount-schema.validator";
import { fromDecimal128 } from "../common/money";
import type { Direction, PostingDoc } from "../ledger/types";

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

/** An ISO-8601 date or date-time. A bare date means midnight UTC. */
const isoInstant = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value));

export const statementQuerySchema = z
  .object({
    walletType: z.enum(WALLET_TYPES).optional(),
    accountType: z.enum(USER_ACCOUNT_TYPES).optional(),
    from: isoInstant.optional(),
    to: isoInstant.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from.getTime() <= q.to.getTime(), {
    message: 'from must be on or before to',
    path: ['from'],
  });
export type StatementQueryDto = z.infer<typeof statementQuerySchema>;

export interface StatementRow {
  postingId: string;
  entryId: string;
  operationId: string;
  operationType: string;
  reference: string | null;
  walletType: WalletType | null;
  accountType: string;
  direction: Direction;
  amount: string;
  balanceAfter: string | null;
  sequence: number | null;
  createdAt: string;
}

export interface StatementPage {
  items: StatementRow[];
  /** Pass back as `cursor` for the next page; null once the statement is exhausted. */
  nextCursor: string | null;
}

export function statementRow(p: PostingDoc): StatementRow {
  return {
    postingId: p._id.toHexString(),
    entryId: p.entryId.toHexString(),
    operationId: p.operationId.toHexString(),
    operationType: p.operationType,
    reference: p.reference,
    walletType: p.walletType,
    accountType: p.accountType,
    direction: p.direction,
    amount: fromDecimal128(p.amount).toString(),
    balanceAfter: p.balanceAfter ? fromDecimal128(p.balanceAfter).toString() : null,
    sequence: p.sequence,
    createdAt: p.createdAt.toISOString(),
  };
}

export interface WalletBalance {
  tenantId: string;
  ownerId: string;
  currency: string;
  walletType: WalletType;
  available: bigint;
  heldInflow: bigint;
  heldOutflow: bigint;
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
    ledger: bal.ledger.toString(),
    refundChargeback: bal.refundChargeback.toString() 
  }
}
