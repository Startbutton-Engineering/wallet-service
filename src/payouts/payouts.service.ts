import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { PAYOUT_TRANSITIONS, PayoutStatus } from "./payout-transitions";

export interface PayoutResult {
  operationId: string;
  entryId: string;
  payoutId: string;
  status: PayoutStatus;
  balance: ReturnType<typeof balanceToJson>;
}

interface PayoutStatusParams {
  tenantId: string;
  idempotencyKey: string;
  payoutId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  status: PayoutStatus;
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  /** Apply one payout lifecycle transition. The payout has no status document — each
   * transition's precondition is derived from the postings already filed under payoutId,
   * inside the same transaction that writes the new ones. */
  async status(params: PayoutStatusParams): Promise<PayoutResult> {
    const { tenantId, idempotencyKey, payoutId, ownerId, currency, amount, status } = params;
    await this.currencies.require(currency);
    const transition = PAYOUT_TRANSITIONS[status];

    return this.ledgerService.post<PayoutResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { payoutId, ownerId, currency, amount: amount.toString(), status },
      reference: payoutId,
      generateLedgerOps: async (ctx) => {
        const planned = await transition.plan(ctx, { payoutId, ownerId, currency, amount });
        return {
          entries: planned.entries,
          guardNegative: planned.guardNegative,
          reversalOf: planned.reversalOf,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            payoutId,
            status,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'payout')),
          }),
          buildEvent: async (post) => ({
            type: transition.eventType,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              payoutId,
              ownerId,
              currency,
              amount: amount.toString(),
              status,
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'payout')),
            },
          }),
        };
      },
    });
  }
}
