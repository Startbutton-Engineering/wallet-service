import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType } from "../ledger/types";
import { accountRef, AccountRef, WalletType } from "../accounts/account";
import { AppError } from "../common/errors";

export const LienOperation = {
  place: 'lien.place',
  release: 'lien.release',
} as const;

export type LienAction = keyof typeof LienOperation;

export interface LienResult {
  operationId: string;
  entryId: string;
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

interface LienTransition {
  operationType: string;
  eventType: OutboxEventType;
  /** Where the amount moves from and to within the wallet. */
  from: 'available' | 'lien';
  to: 'available' | 'lien';
  alreadyApplied: (lienId: string) => AppError;
}

const TRANSITIONS: Record<LienAction, LienTransition> = {
  /** Fence off part of `available`: it stays the owner's (and in `ledger`) but can't be spent. */
  place: {
    operationType: LienOperation.place,
    eventType: OutboxEventType.LIEN_PLACED,
    from: 'available',
    to: 'lien',
    alreadyApplied: (lienId) => AppError.lienAlreadyPlaced(lienId),
  },
  /** Hand the fenced-off amount back to `available`. */
  release: {
    operationType: LienOperation.release,
    eventType: OutboxEventType.LIEN_RELEASED,
    from: 'lien',
    to: 'available',
    alreadyApplied: (lienId) => AppError.lienAlreadyReleased(lienId),
  },
};

@Injectable()
export class LiensService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  /** Move `amount` between the wallet's `available` and `lien` accounts. Every debit guards
   * `available`, so a placed lien blocks spending with no change to any other operation. */
  async apply(action: LienAction, params: LienParams): Promise<LienResult> {
    const { tenantId, idempotencyKey, lienId, ownerId, walletType, currency, amount } = params;
    await this.currencies.require(currency);
    const transition = TRANSITIONS[action];
    const from: AccountRef = accountRef.user(ownerId, currency, walletType, transition.from);
    const to: AccountRef = accountRef.user(ownerId, currency, walletType, transition.to);

    return this.ledgerService.post<LienResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { lienId, ownerId, walletType, currency, amount: amount.toString() },
      reference: lienId,
      generateLedgerOps: async (ctx) => {
        const applied = await ctx.referenceNetAmount(lienId, to, [transition.operationType]);
        if (applied !== 0n) throw transition.alreadyApplied(lienId);

        return {
          entries: [{
            currency,
            postings: [
              { account: from, direction: 'debit', amount },
              { account: to, direction: 'credit', amount },
            ],
          }],
          // Placing can't take more than is spendable; releasing can't free more than is held.
          guardNegative: [from],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
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
              balance: balanceToJson(await post.accountBalance(ownerId, currency, walletType)),
            },
          }),
        };
      },
    });
  }
}
