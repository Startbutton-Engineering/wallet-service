import { accountRef, AccountRef } from "../accounts/account";
import { AppError } from "../common/errors";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI, OutboxEventType } from "../ledger/types";

export const PAYOUT_STATUSES = ['initiated', 'success', 'failed', 'reversed', 'reverse-failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** operationType stamped on every entry and posting; also the key the state machine
 * reads back through PrePostContext.referenceNetAmount. Never change these strings
 * without a migration — posted history is interpreted through them. */
export const PayoutOperation = {
  initiate: 'payout.initiate',
  success: 'payout.success',
  failed: 'payout.failed',
  reverse: 'payout.reverse',
  reverseFailed: 'payout.reverse-failed',
} as const;

export interface TransitionParams {
  payoutId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
}

export interface TransitionPlan {
  entries: EntryI[];
  guardNegative: AccountRef[];
  reversalOf?: string;
}

export interface Transition {
  operationType: string;
  eventType: OutboxEventType;
  plan: (ctx: PrePostContext, params: TransitionParams) => Promise<TransitionPlan>;
}

const held = (ownerId: string, currency: string): AccountRef =>
  accountRef.payoutWallet(ownerId, currency, 'held-outflow');

const available = (ownerId: string, currency: string): AccountRef =>
  accountRef.payoutWallet(ownerId, currency, 'available');

/** How much of this payout was ever put on hold. Only payout.initiate credits held-outflow,
 * so this stays at the initiated amount for the payout's whole life. */
const initiatedAmount = (ctx: PrePostContext, p: TransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.payoutId, held(p.ownerId, p.currency), [PayoutOperation.initiate]);

/** Still on hold: the initiated amount until success or failure clears it. */
const heldAmount = (ctx: PrePostContext, p: TransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.payoutId, held(p.ownerId, p.currency));

/** Sitting with the outside world: credited by success, taken back by reverse,
 * credited again by reverse-failed. */
const paidOutAmount = (ctx: PrePostContext, p: TransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.payoutId, accountRef.systemPayout(p.currency), [
    PayoutOperation.success,
    PayoutOperation.reverse,
    PayoutOperation.reverseFailed,
  ]);

/** Handed back to the owner and not yet taken away again. Reached either by failing the
 * payout or by reversing a successful one — reverse-failed undoes both the same way. */
const returnedAmount = (ctx: PrePostContext, p: TransitionParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.payoutId, available(p.ownerId, p.currency), [
    PayoutOperation.failed,
    PayoutOperation.reverse,
    PayoutOperation.reverseFailed,
  ]);

function assertExact(outstanding: bigint, p: TransitionParams): void {
  if (outstanding !== p.amount) {
    throw AppError.payoutAmountMismatch({
      payoutId: p.payoutId,
      requested: p.amount.toString(),
      outstanding: outstanding.toString(),
    });
  }
}

/** Shared precondition for success and failed: the payout must be initiated and still held,
 * for exactly this amount. */
async function requireHeld(ctx: PrePostContext, p: TransitionParams): Promise<void> {
  const initiated = await initiatedAmount(ctx, p);
  if (initiated === 0n) throw AppError.payoutNotInitiated(p.payoutId);

  const outstanding = await heldAmount(ctx, p);
  if (outstanding === 0n) {
    throw AppError.payoutAlreadyResolved({
      payoutId: p.payoutId,
      initiated: initiated.toString(),
    });
  }
  assertExact(outstanding, p);
}

export const PAYOUT_TRANSITIONS: Record<PayoutStatus, Transition> = {
  /** Reserve the funds: they leave `available` but stay in the wallet's ledger total. */
  initiated: {
    operationType: PayoutOperation.initiate,
    eventType: OutboxEventType.PAYOUT_INITIATED,
    plan: async (ctx, p) => {
      const already = await initiatedAmount(ctx, p);
      if (already !== 0n) throw AppError.payoutAlreadyInitiated(p.payoutId);

      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: available(p.ownerId, p.currency), direction: 'debit', amount: p.amount },
            { account: held(p.ownerId, p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [available(p.ownerId, p.currency)],
      };
    },
  },

  /** The money reached the outside world: release the hold against the external account. */
  success: {
    operationType: PayoutOperation.success,
    eventType: OutboxEventType.PAYOUT_SUCCEEDED,
    plan: async (ctx, p) => {
      await requireHeld(ctx, p);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: held(p.ownerId, p.currency), direction: 'debit', amount: p.amount },
            { account: accountRef.systemPayout(p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [held(p.ownerId, p.currency)],
      };
    },
  },

  /** Never left: give the hold back to the owner. */
  failed: {
    operationType: PayoutOperation.failed,
    eventType: OutboxEventType.PAYOUT_FAILED,
    plan: async (ctx, p) => {
      await requireHeld(ctx, p);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: held(p.ownerId, p.currency), direction: 'debit', amount: p.amount },
            { account: available(p.ownerId, p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [held(p.ownerId, p.currency)],
      };
    },
  },

  /** It went out, then bounced back. Refund the owner straight to `available` —
   * the hold is long gone. */
  reversed: {
    operationType: PayoutOperation.reverse,
    eventType: OutboxEventType.PAYOUT_REVERSED,
    plan: async (ctx, p) => {
      const paidOut = await paidOutAmount(ctx, p);
      if (paidOut === 0n) {
        throw AppError.payoutNotSuccessful({
          payoutId: p.payoutId,
          requested: p.amount.toString(),
        });
      }
      assertExact(paidOut, p);

      const successEntries = await ctx.referenceEntryIds(p.payoutId, PayoutOperation.success);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: accountRef.systemPayout(p.currency), direction: 'debit', amount: p.amount },
            { account: available(p.ownerId, p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        guardNegative: [],
        reversalOf: successEntries.at(-1),
      };
    },
  },

  /** The refund was wrong: the payout really did go out after all. Take the money back.
   * Reached either from `failed` (a late success webhook) or from `reversed` (the reversal
   * itself failed) — both leave the funds sitting in `available`, so one guard covers both. */
  'reverse-failed': {
    operationType: PayoutOperation.reverseFailed,
    eventType: OutboxEventType.PAYOUT_REVERSE_FAILED,
    plan: async (ctx, p) => {
      const returned = await returnedAmount(ctx, p);
      if (returned === 0n) {
        throw AppError.payoutNotReversed({
          payoutId: p.payoutId,
          requested: p.amount.toString(),
        });
      }
      assertExact(returned, p);

      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: available(p.ownerId, p.currency), direction: 'debit', amount: p.amount },
            { account: accountRef.systemPayout(p.currency), direction: 'credit', amount: p.amount },
          ],
        }],
        // The owner may already have spent the refund; this must 422 rather than go negative.
        guardNegative: [available(p.ownerId, p.currency)],
      };
    },
  },
};
