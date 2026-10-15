import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType } from "../ledger/types";
import { accountRef } from "../accounts/account";
import { AppError } from "../common/errors";
import { debitWithOverdraft } from "../collections/credit-policy";

export const DisputeOperation = {
  accept: 'dispute.accept',
} as const;

export interface DisputeResult {
  operationId: string;
  entryId: string;
  disputeId: string;
  fromAvailable: string;
  deficit: string;
  balance: ReturnType<typeof balanceToJson>;
}

export interface DisputeAcceptParams {
  tenantId: string;
  idempotencyKey: string;
  disputeId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  /** Let a shortfall in `available` become refund-chargeback debt, repaid by later collections. */
  allowOverdraft: boolean;
}

@Injectable()
export class DisputesService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  /** Charge an accepted dispute to the owner's collection wallet: `available` first, and with an
   * overdraft the shortfall as refund-chargeback debt. The disputed collection is reversed, so the
   * amount goes back out through external:collection, the account it came in on. */
  async accept(params: DisputeAcceptParams): Promise<DisputeResult> {
    const { tenantId, idempotencyKey, disputeId, ownerId, currency, amount, allowOverdraft } = params;
    await this.currencies.require(currency);
    const collectionRail = accountRef.systemCollection(currency);

    return this.ledgerService.post<DisputeResult>({
      tenantId,
      idempotencyKey,
      operationType: DisputeOperation.accept,
      requestPayload: { disputeId, ownerId, currency, amount: amount.toString(), allowOverdraft },
      reference: disputeId,
      generateLedgerOps: async (ctx) => {
        const applied = await ctx.referenceNetAmount(disputeId, collectionRail, [DisputeOperation.accept]);
        if (applied !== 0n) throw AppError.disputeAlreadyAccepted(disputeId);

        const current = await ctx.readBalance(ownerId, currency, 'collection');
        const { postings, fromAvailable, deficit } = debitWithOverdraft({
          ownerId,
          currency,
          amount,
          available: current.available,
          allowOverdraft,
        });
        const split = { fromAvailable: fromAvailable.toString(), deficit: deficit.toString() };

        return {
          entries: [{
            currency,
            postings: [...postings, { account: collectionRail, direction: 'credit', amount }],
          }],
          guardNegative: [accountRef.collectionWallet(ownerId, currency, 'available')],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            disputeId,
            ...split,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
          }),
          buildEvent: async (post) => ({
            type: OutboxEventType.DISPUTE_ACCEPTED,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              disputeId,
              ownerId,
              currency,
              amount: amount.toString(),
              ...split,
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
            },
          }),
        };
      },
    });
  }
}
