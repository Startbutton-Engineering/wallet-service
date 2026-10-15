import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType } from "../ledger/types";
import { accountRef, AccountRef, WalletType } from "../accounts/account";
import { AppError } from "../common/errors";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI } from "../ledger/types";

export const LienOperation = {
  place: 'lien.place',
  release: 'lien.release',
} as const;

export type LienAction = keyof typeof LienOperation;

export interface LienResult {
  operationId: string;
  /** Null when a place set the lien to the amount already held, so nothing was posted. */
  entryId: string | null;
  lienId: string;
  balance: ReturnType<typeof balanceToJson>;
}

export interface LienParams {
  tenantId: string;
  idempotencyKey: string;
  lienId: string;
  ownerId: string;
  walletType: WalletType;
  currency: string;
  amount: bigint;
}

interface LienPlan {
  postings: EntryI['postings'];
  guardNegative: AccountRef[];
  previousLien?: bigint;
}

interface LienTransition {
  operationType: string;
  eventType: OutboxEventType;
  applied: 'available' | 'lien';
  alreadyApplied: (lienId: string) => AppError;
  plan: (ctx: PrePostContext, params: LienParams, account: (type: 'available' | 'lien') => AccountRef) => Promise<LienPlan>;
}

const move = (from: AccountRef, to: AccountRef, amount: bigint): EntryI['postings'] => [
  { account: from, direction: 'debit', amount },
  { account: to, direction: 'credit', amount },
];

const TRANSITIONS: Record<LienAction, LienTransition> = {
  place: {
    operationType: LienOperation.place,
    eventType: OutboxEventType.LIEN_PLACED,
    applied: 'lien',
    alreadyApplied: (lienId) => AppError.lienAlreadyPlaced(lienId),
    plan: async (ctx, { ownerId, currency, walletType, amount }, account) => {
      const { lien: previousLien } = await ctx.readBalance(ownerId, currency, walletType);
      const delta = amount - previousLien;
      if (delta > 0n) {
        return { postings: move(account('available'), account('lien'), delta), guardNegative: [account('available')], previousLien };
      }
      if (delta < 0n) {
        return { postings: move(account('lien'), account('available'), -delta), guardNegative: [account('lien')], previousLien };
      }
      return { postings: [], guardNegative: [], previousLien };
    },
  },
  /** Hand the fenced-off amount back to `available`; it can't free more than is held. */
  release: {
    operationType: LienOperation.release,
    eventType: OutboxEventType.LIEN_RELEASED,
    applied: 'available',
    alreadyApplied: (lienId) => AppError.lienAlreadyReleased(lienId),
    plan: async (_ctx, { amount }, account) => ({
      postings: move(account('lien'), account('available'), amount),
      guardNegative: [account('lien')],
    }),
  },
};

@Injectable()
export class LiensService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  async apply(action: LienAction, params: LienParams): Promise<LienResult> {
    const { tenantId, idempotencyKey, lienId, ownerId, walletType, currency, amount } = params;
    await this.currencies.require(currency);
    const transition = TRANSITIONS[action];
    const account = (type: 'available' | 'lien'): AccountRef => accountRef.user(ownerId, currency, walletType, type);

    return this.ledgerService.post<LienResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { lienId, ownerId, walletType, currency, amount: amount.toString() },
      reference: lienId,
      generateLedgerOps: async (ctx) => {
        const applied = await ctx.referenceNetAmount(lienId, account(transition.applied), [transition.operationType]);
        if (applied !== 0n) throw transition.alreadyApplied(lienId);

        const planned = await transition.plan(ctx, params, account);
        return {
          entries: planned.postings.length ? [{ currency, postings: planned.postings }] : [],
          guardNegative: planned.guardNegative,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0] ?? null,
            lienId,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, walletType)),
          }),
          buildEvent: async (post) => ({
            type: transition.eventType,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              lienId,
              ownerId,
              walletType,
              currency,
              amount: amount.toString(),
              ...(planned.previousLien !== undefined && { previousLien: planned.previousLien.toString() }),
              balance: balanceToJson(await post.accountBalance(ownerId, currency, walletType)),
            },
          }),
        };
      },
    });
  }
}
