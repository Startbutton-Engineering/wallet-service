import { accountRef, AccountRef, WalletType } from "../accounts/account";
import { AppError } from "../common/errors";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI, OutboxEventType } from "../ledger/types";

export const SettlementOperation = {
  initiate: 'settlement.initiate',
  success: 'settlement.success',
  failed: 'settlement.failed',
} as const;

export const SETTLEMENT_RESOLUTIONS = ['success', 'failed'] as const;
export type SettlementResolution = (typeof SETTLEMENT_RESOLUTIONS)[number];

export interface InitiateParams {
  settlementId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  walletType: WalletType;
}

export interface ResolveParams {
  settlementId: string;
  ownerId: string;
  currency: string;
  walletType: WalletType;
}

export interface SettlementPlan {
  entries: EntryI[];
  guardNegative: AccountRef[];
}

export interface ResolutionTransition {
  operationType: string;
  eventType: OutboxEventType;
  plan: (ctx: PrePostContext, p: ResolveParams) => Promise<SettlementPlan>;
}

const held = (ownerId: string, currency: string, walletType: WalletType): AccountRef =>
  accountRef.user(ownerId, currency, walletType, 'held-outflow');

const available = (ownerId: string, currency: string, walletType: WalletType): AccountRef =>
  accountRef.user(ownerId, currency, walletType, 'available');

const initiatedAmount = (ctx: PrePostContext, p: ResolveParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.settlementId, held(p.ownerId, p.currency, p.walletType), [SettlementOperation.initiate]);

/** Still on hold: the initiated amount until success or failure clears it. */
const heldAmount = (ctx: PrePostContext, p: ResolveParams): Promise<bigint> =>
  ctx.referenceNetAmount(p.settlementId, held(p.ownerId, p.currency, p.walletType));

async function requirePending(ctx: PrePostContext, p: ResolveParams): Promise<bigint> {
  const initiated = await initiatedAmount(ctx, p);
  if (initiated === 0n) throw AppError.settlementNotInitiated(p.settlementId);

  const outstanding = await heldAmount(ctx, p);
  if (outstanding === 0n) {
    throw AppError.settlementAlreadyResolved({
      settlementId: p.settlementId,
      initiated: initiated.toString(),
    });
  }
  return outstanding;
}

export async function planInitiate(ctx: PrePostContext, p: InitiateParams): Promise<SettlementPlan> {
  const already = await initiatedAmount(ctx, p);
  if (already !== 0n) throw AppError.settlementAlreadyInitiated(p.settlementId);

  return {
    entries: [{
      currency: p.currency,
      metadata: {
        settlementId: p.settlementId,
        ownerId: p.ownerId,
        currency: p.currency,
        amount: p.amount.toString(),
        walletType: p.walletType,
      },
      postings: [
        { account: available(p.ownerId, p.currency, p.walletType), direction: 'debit', amount: p.amount },
        { account: held(p.ownerId, p.currency, p.walletType), direction: 'credit', amount: p.amount },
      ],
    }],
    guardNegative: [available(p.ownerId, p.currency, p.walletType)],
  };
}

export const SETTLEMENT_TRANSITIONS: Record<SettlementResolution, ResolutionTransition> = {
  /** The funds reached the merchant's bank: release the hold against the external account. */
  success: {
    operationType: SettlementOperation.success,
    eventType: OutboxEventType.SETTLEMENT_SUCCEEDED,
    plan: async (ctx, p) => {
      const amount = await requirePending(ctx, p);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: held(p.ownerId, p.currency, p.walletType), direction: 'debit', amount },
            { account: accountRef.systemPayout(p.currency), direction: 'credit', amount },
          ],
        }],
        guardNegative: [held(p.ownerId, p.currency, p.walletType)],
      };
    },
  },

  /** Declined or never left: give the hold back to the owner. */
  failed: {
    operationType: SettlementOperation.failed,
    eventType: OutboxEventType.SETTLEMENT_FAILED,
    plan: async (ctx, p) => {
      const amount = await requirePending(ctx, p);
      return {
        entries: [{
          currency: p.currency,
          postings: [
            { account: held(p.ownerId, p.currency, p.walletType), direction: 'debit', amount },
            { account: available(p.ownerId, p.currency, p.walletType), direction: 'credit', amount },
          ],
        }],
        guardNegative: [held(p.ownerId, p.currency, p.walletType)],
      };
    },
  },
};
