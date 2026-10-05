import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { REFUND_TRANSITIONS, RefundStatus } from "./refund-transitions";
import { REFUND_FEE_TRANSITIONS, RefundFeeStatus } from "./refund-fee-transitions";

export interface RefundResult {
  operationId: string;
  entryId: string;
  refundId: string;
  status: RefundStatus;
  balance: ReturnType<typeof balanceToJson>;
}

interface RefundStatusParams {
  tenantId: string;
  idempotencyKey: string;
  refundId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  status: RefundStatus;
  allowOverdraft: boolean;
}

export interface RefundFeeResult {
  operationId: string;
  entryId: string;
  refundId: string;
  transferReference: string;
  status: RefundFeeStatus;
  balance: ReturnType<typeof balanceToJson>;
}

interface RefundFeeStatusParams {
  tenantId: string;
  idempotencyKey: string;
  refundId: string;
  transferReference: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  status: RefundFeeStatus;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  /** Apply one refund lifecycle transition against the owner's collection wallet. Like payouts,
   * there is no status document: preconditions come from the postings filed under refundId. */
  async status(params: RefundStatusParams): Promise<RefundResult> {
    const { tenantId, idempotencyKey, refundId, ownerId, currency, amount, status, allowOverdraft } = params;
    await this.currencies.require(currency);
    const transition = REFUND_TRANSITIONS[status];

    return this.ledgerService.post<RefundResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { refundId, ownerId, currency, amount: amount.toString(), status, allowOverdraft },
      reference: refundId,
      generateLedgerOps: async (ctx) => {
        const planned = await transition.plan(ctx, { refundId, ownerId, currency, amount, allowOverdraft });
        return {
          entries: planned.entries,
          guardNegative: planned.guardNegative,
          reversalOf: planned.reversalOf,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            refundId,
            status,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
          }),
          buildEvent: async (post) => ({
            type: transition.eventType,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              refundId,
              ownerId,
              currency,
              amount: amount.toString(),
              status,
              ...planned.eventMetaData,
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
            },
          }),
        };
      },
    });
  }

  /** Apply one transition of the bank-transfer fee charged for paying a refund out. The fee has
   * its own lifecycle and amount, filed under the transfer reference with the refund id in each
   * entry's metadata. */
  async feeStatus(params: RefundFeeStatusParams): Promise<RefundFeeResult> {
    const { tenantId, idempotencyKey, refundId, transferReference, ownerId, currency, amount, status } = params;
    await this.currencies.require(currency);
    const transition = REFUND_FEE_TRANSITIONS[status];

    return this.ledgerService.post<RefundFeeResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { refundId, transferReference, ownerId, currency, amount: amount.toString(), status },
      reference: transferReference,
      generateLedgerOps: async (ctx) => {
        const planned = await transition.plan(ctx, { refundId, transferReference, ownerId, currency, amount });
        return {
          entries: planned.entries,
          guardNegative: planned.guardNegative,
          reversalOf: planned.reversalOf,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            refundId,
            transferReference,
            status,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
          }),
          buildEvent: async (post) => ({
            type: transition.eventType,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              refundId,
              transferReference,
              ownerId,
              currency,
              amount: amount.toString(),
              status,
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
            },
          }),
        };
      },
    });
  }
}
