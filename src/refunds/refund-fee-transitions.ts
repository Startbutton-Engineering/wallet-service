import { accountRef, AccountRef } from "../accounts/account";
import { AppError } from "../common/errors";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI, OutboxEventType } from "../ledger/types";
import { RefundOperation } from "./refund-transitions";

export const REFUND_FEE_STATUSES = ['initiated', 'success', 'reversed', 'reverse-failed'] as const;
export type RefundFeeStatus = (typeof REFUND_FEE_STATUSES)[number];

export const RefundFeeOperation = {
  initiate: 'refund.fee.initiate',
  success: 'refund.fee.success',
  reverse: 'refund.fee.reverse',
  reverseFailed: 'refund.fee.reverse-failed',
} as const;

export interface RefundFeeTransitionParams {
  refundId: string;
  transferReference: string;
  ownerId: string;
  currency: string;
  amount: bigint;
}

export interface RefundFeeTransitionPlan {
  entries: EntryI[];
  guardNegative: AccountRef[];
  reversalOf?: string;
}

export interface RefundFeeTransition {
  operationType: string;
  eventType: OutboxEventType;
  plan: (ctx: PrePostContext, params: RefundFeeTransitionParams) => Promise<RefundFeeTransitionPlan>;
}

const available = (ownerId: string, currency: string): AccountRef =>
  accountRef.collectionWallet(ownerId, currency, 'available');

const held = (ownerId: string, currency: string): AccountRef =>
  accountRef.collectionWallet(ownerId, currency, 'held-outflow');

const details = (p: RefundFeeTransitionParams, extra: Record<string, string> = {}) => ({
  refundId: p.refundId,
  transferReference: p.transferReference,
  requested: p.amount.toString(),
  ...extra,
});

/** One entry moving the fee between two accounts, stamped with the refund it belongs to. */
const feeEntry = (p: RefundFeeTransitionParams, from: AccountRef, to: AccountRef): EntryI => ({
  currency: p.currency,
  metadata: { refundId: p.refundId, transferReference: p.transferReference, purpose: 'refund-transfer-fee' },
  postings: [
    { account: from, direction: 'debit', amount: p.amount },
    { account: to, direction: 'credit', amount: p.amount },
  ],
});

/** Only fee.initiate credits held-outflow, so this stays at the fee amount for the fee's whole life. */
const initiatedAmount = (ctx: PrePostContext, p: RefundFeeTransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.transferReference, held(p.ownerId, p.currency), [RefundFeeOperation.initiate]);

/** Still on hold: the fee until success or reversal clears it. */
const heldAmount = (ctx: PrePostContext, p: RefundFeeTransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.transferReference, held(p.ownerId, p.currency));

/** Handed back by a reversal and not yet taken again by reverse-failed. */
const returnedAmount = (ctx: PrePostContext, p: RefundFeeTransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.transferReference, available(p.ownerId, p.currency), [
    RefundFeeOperation.reverse,
    RefundFeeOperation.reverseFailed,
  ]);

function assertExact(outstanding: bigint, p: RefundFeeTransitionParams): void {
  if (outstanding !== p.amount) {
    throw AppError.refundFeeAmountMismatch(details(p, { outstanding: outstanding.toString() }));
  }
}

/** Shared precondition for success and reversed: the fee is initiated and still held, for exactly this amount. */
async function requireHeld(ctx: PrePostContext, p: RefundFeeTransitionParams): Promise<void> {
  const initiated = await initiatedAmount(ctx, p);
  if (initiated === 0n) throw AppError.refundFeeNotInitiated(details(p));

  const outstanding = await heldAmount(ctx, p);
  if (outstanding === 0n) throw AppError.refundFeeAlreadyResolved(details(p, { initiated: initiated.toString() }));
  assertExact(outstanding, p);
}

export const REFUND_FEE_TRANSITIONS: Record<RefundFeeStatus, RefundFeeTransition> = {
  /** Hold the fee: it leaves `available` but stays in the wallet's ledger total. Never an
   * overdraft — an owner who cannot cover the fee is rejected with INSUFFICIENT_FUNDS. */
  initiated: {
    operationType: RefundFeeOperation.initiate,
    eventType: OutboxEventType.REFUND_FEE_INITIATED,
    plan: async (ctx, p) => {
      const refunded = await ctx.referenceNetAmount(p.refundId, accountRef.systemRefunds(p.currency), [RefundOperation.pending]);
      if (refunded === 0n) throw AppError.refundNotInitiated(p.refundId);

      const already = await initiatedAmount(ctx, p);
      if (already !== 0n) throw AppError.refundFeeAlreadyInitiated(details(p));

      return {
        entries: [feeEntry(p, available(p.ownerId, p.currency), held(p.ownerId, p.currency))],
        guardNegative: [available(p.ownerId, p.currency)],
      };
    },
  },

  /** The transfer went through: the fee is charged and lands in external:refunds. */
  success: {
    operationType: RefundFeeOperation.success,
    eventType: OutboxEventType.REFUND_FEE_SUCCEEDED,
    plan: async (ctx, p) => {
      await requireHeld(ctx, p);
      return {
        entries: [feeEntry(p, held(p.ownerId, p.currency), accountRef.systemRefunds(p.currency))],
        guardNegative: [held(p.ownerId, p.currency)],
      };
    },
  },

  /** The transfer failed: release the hold back to `available`. */
  reversed: {
    operationType: RefundFeeOperation.reverse,
    eventType: OutboxEventType.REFUND_FEE_REVERSED,
    plan: async (ctx, p) => {
      await requireHeld(ctx, p);
      const initiateEntries = await ctx.referenceEntryIds(p.transferReference, RefundFeeOperation.initiate);
      return {
        entries: [feeEntry(p, held(p.ownerId, p.currency), available(p.ownerId, p.currency))],
        guardNegative: [held(p.ownerId, p.currency)],
        reversalOf: initiateEntries.at(-1),
      };
    },
  },

  /** A success arrived after the reversal: charge the fee after all, straight from `available`. */
  'reverse-failed': {
    operationType: RefundFeeOperation.reverseFailed,
    eventType: OutboxEventType.REFUND_FEE_REVERSE_FAILED,
    plan: async (ctx, p) => {
      const returned = await returnedAmount(ctx, p);
      if (returned === 0n) throw AppError.refundFeeNotReversed(details(p));
      assertExact(returned, p);

      return {
        entries: [feeEntry(p, available(p.ownerId, p.currency), accountRef.systemRefunds(p.currency))],
        // The owner may already have spent the returned fee; this must 422 rather than go negative.
        guardNegative: [available(p.ownerId, p.currency)],
      };
    },
  },
};
