import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType } from "../ledger/types";
import { accountRef } from "../accounts/account";
import { AppError } from "../common/errors";

export const TopupOperation = {
  credit: 'topup.credit',
} as const;

export interface TopupResult {
  operationId: string;
  entryId: string;
  topupId: string;
  balance: ReturnType<typeof balanceToJson>;
}

interface TopupParams {
  tenantId: string;
  idempotencyKey: string;
  topupId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
}

@Injectable()
export class TopupsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  async credit(params: TopupParams): Promise<TopupResult> {
    const { tenantId, idempotencyKey, topupId, ownerId, currency, amount } = params;
    await this.currencies.require(currency);
    const available = accountRef.payoutWallet(ownerId, currency, 'available');

    return this.ledgerService.post<TopupResult>({
      tenantId,
      idempotencyKey,
      operationType: TopupOperation.credit,
      requestPayload: { topupId, ownerId, currency, amount: amount.toString() },
      reference: topupId,
      generateLedgerOps: async (ctx) => {
        const alreadyCredited = await ctx.referenceNetAmount(topupId, available, [TopupOperation.credit]);
        if (alreadyCredited !== 0n) throw AppError.topupAlreadyCredited(topupId);

        return {
          entries: [{
            currency,
            postings: [
              { account: accountRef.systemCollection(currency), direction: 'debit', amount },
              { account: available, direction: 'credit', amount },
            ],
          }],
          guardNegative: [],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            topupId,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'payout')),
          }),
          buildEvent: async (post) => ({
            type: OutboxEventType.TOPUP_CREDITED,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              topupId,
              ownerId,
              currency,
              amount: amount.toString(),
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'payout')),
            },
          }),
        };
      },
    });
  }
}
