import { accountRef, AccountRef } from "../accounts/account";
import { AppError } from "../common/errors";
import { debitWithOverdraft, reverseOverdraftDebit } from "../collections/credit-policy";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI, OutboxEventType } from "../ledger/types";

export const REFUND_STATUSES = ['pending', 'success', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const RefundOperation = {
  pending: 'refund.pending',
  success: 'refund.success',
  failed: 'refund.failed',
} as const;

export interface RefundTransitionParams {
  refundId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  /** Only read by `pending`: let a shortfall in `available` become refund-chargeback debt. */
  allowOverdraft: boolean;
}

export interface RefundTransitionPlan {
  entries: EntryI[];
  guardNegative: AccountRef[];
  reversalOf?: string;
  /** How the amount was split across the owner's accounts, surfaced on the event. */
  eventMetaData: Record<string, string>;
}

export interface RefundTransition {
  operationType: string;
  eventType: OutboxEventType;
  plan: (ctx: PrePostContext, params: RefundTransitionParams) => Promise<RefundTransitionPlan>;
}

const available = (ownerId: string, currency: string): AccountRef =>
  accountRef.collectionWallet(ownerId, currency, 'available');

const debt = (ownerId: string, currency: string): AccountRef =>
  accountRef.collectionWallet(ownerId, currency, 'refund-chargeback');

/** Only refund.pending credits external:refunds, so this stays at the refunded amount. */
const pendingAmount = (ctx: PrePostContext, p: RefundTransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.refundId, accountRef.systemRefunds(p.currency), [RefundOperation.pending]);

/** In flight: the pending amount until success or failure takes it out of external:refunds. */
const inFlightAmount = (ctx: PrePostContext, p: RefundTransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.refundId, accountRef.systemRefunds(p.currency));

/** Shared precondition for success and failed: pending and still in flight, for exactly this amount. */
async function requireInFlight(ctx: PrePostContext, p: RefundTransitionParams): Promise<void> {
  const pending = await pendingAmount(ctx, p);
  if (pending === 0n) throw AppError.refundNotInitiated(p.refundId);

  const outstanding = await inFlightAmount(ctx, p);
  if (outstanding === 0n) {
    throw AppError.refundAlreadyResolved({ refundId: p.refundId, pending: pending.toString() });
  }
  if (outstanding !== p.amount) {
    throw AppError.refundAmountMismatch({
      refundId: p.refundId,
      requested: p.amount.toString(),
      outstanding: outstanding.toString(),
    });
  }
}

export const REFUND_TRANSITIONS: Record<RefundStatus, RefundTransition> = {
  /** Take the refund out of the collection wallet: `available` first, and with an overdraft
   * the shortfall as refund-chargeback debt. Both balances drop now, not on success. */
  pending: {
    operationType: RefundOperation.pending,
    eventType: OutboxEventType.REFUND_PENDING,
    plan: async (ctx, p) => {
      const already = await pendingAmount(ctx, p);
      if (already !== 0n) throw AppError.refundAlreadyInitiated(p.refundId);

      const current = await ctx.readBalance(p.ownerId, p.currency, 'collection');
      const { postings, fromAvailable, deficit } = debitWithOverdraft({
        ownerId: p.ownerId,
        currency: p.currency,
        amount: p.amount,
        available: current.available,
        allowOverdraft: p.allowOverdraft,
      });
      return {
        entries: [{
          currency: p.currency,
          postings: [
            ...postings,
            { account: accountRef.systemRefunds(p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [available(p.ownerId, p.currency)],
        eventMetaData: { fromAvailable: fromAvailable.toString(), deficit: deficit.toString() },
      };
    },
  },

  /** The customer has the money: it leaves through the collection rail it came in on. */
  success: {
    operationType: RefundOperation.success,
    eventType: OutboxEventType.REFUND_SUCCEEDED,
    plan: async (ctx, p) => {
      await requireInFlight(ctx, p);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: accountRef.systemRefunds(p.currency), direction: 'debit', amount: p.amount },
            { account: accountRef.systemCollection(p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [],
        eventMetaData: {},
      };
    },
  },

  /** Never reached the customer: give it back, cancelling whatever debt the pending step created. */
  failed: {
    operationType: RefundOperation.failed,
    eventType: OutboxEventType.REFUND_FAILED,
    plan: async (ctx, p) => {
      await requireInFlight(ctx, p);

      const deficit = -(await ctx.referenceNetAmount(p.refundId, debt(p.ownerId, p.currency), [RefundOperation.pending]));
      const current = await ctx.readBalance(p.ownerId, p.currency, 'collection');
      const { postings, toDebt, toAvailable } = reverseOverdraftDebit({
        ownerId: p.ownerId,
        currency: p.currency,
        amount: p.amount,
        deficit,
        refundChargeBackBalance: current.refundChargeback,
      });
      const pendingEntries = await ctx.referenceEntryIds(p.refundId, RefundOperation.pending);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: accountRef.systemRefunds(p.currency), direction: 'debit', amount: p.amount },
            ...postings,
          ],
        }],
        guardNegative: [],
        reversalOf: pendingEntries.at(-1),
        eventMetaData: { restoredToAvailable: toAvailable.toString(), restoredToDebt: toDebt.toString() },
      };
    },
  },
};
