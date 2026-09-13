import { Injectable } from "@nestjs/common";
import { LedgerService, PostPostingContext, PrePostContext } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType, OutboxEventI, PostingI } from "../ledger/types";
import { accountRef } from "../accounts/account";
import { creditWithDebtPaydown } from "./credit-policy";
import { AppError } from "../common/errors";

export interface CollectionResult {
  operationId: string;
  entryId: string;
  collectionId: string;
  balance: ReturnType<typeof balanceToJson>
}

interface CollectionParams {
  tenantId: string;
  idempotencyKey: string;
  collectionId: string;
  ownerId: string;
  currency: string;
  amount: bigint
}

@Injectable()
export class CollectionsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private currencies: CurrencyRegistryService
  ){}

  async collect(params: CollectionParams): Promise<CollectionResult> {
    const {ownerId, currency, amount, collectionId} = params;
    return this.post(params, 'collection.receive', OutboxEventType.COLLECTION_RECEIVED, async(ctx) => {
      const alreadyReceived = await ctx.referenceNetAmount(
        collectionId,
        accountRef.user(ownerId, currency, 'held-inflow'),
        ['collection.receive']
      );
      if (alreadyReceived !== 0n) throw AppError.collectionAlreadyReceived(collectionId);

      return {
        postings: [
          { account: accountRef.collection(currency), direction: 'debit', amount},
          { account: accountRef.user(ownerId, currency, 'held-inflow'), direction: 'credit', amount}
        ]
      }
    })
  }

  async settled(params: CollectionParams): Promise<CollectionResult> {
    const { ownerId, currency, amount, collectionId } = params;
    return this.post(params, 'collection.settle', OutboxEventType.COLLECTION_SETTLED, async(ctx) => {
      const outstanding = await ctx.referenceNetAmount(
        collectionId,
        accountRef.user(ownerId, currency, 'held-inflow')
      );
      if (amount > outstanding) {
        throw AppError.collectionOverSettlement({
          collectionId,
          requested: amount.toString(),
          outstanding: outstanding.toString()
        });
      }

      const current = await ctx.readBalance(ownerId, currency);
      const { postings, settled, amountToCredit } = creditWithDebtPaydown({
        ownerId,
        currency,
        amount,
        refundChargeBackBalance: current.refundChargeback
      });
      return {
        postings: [
          { account: accountRef.user(ownerId, currency, 'held-inflow'), direction: 'debit', amount },
          ...postings
        ],
        eventMetaData: {
          settledToDebit: settled.toString(),
          amountToCredit: amountToCredit.toString(),
        },
        alsoEmit: settled > 0n ? ['ReffunChargebackSettled'] : []
      }
    })
  }

  private async post(
    params: CollectionParams,
    operationType: string,
    eventType: OutboxEventType,
    plan: (ctx: PrePostContext) => Promise<{
      postings: PostingI[];
      guardHeld?: boolean;
      reversalOf?: string;
      eventMetaData?: Record<string, unknown>;
      alsoEmit?: string[]
    }>
  ):Promise<CollectionResult> {
    const { tenantId, idempotencyKey, collectionId, ownerId, currency, amount } = params;
    await this.currencies.require(currency);

    return this.ledgerService.post<CollectionResult>({
      tenantId,
      idempotencyKey,
      operationType,
      requestPayload: { collectionId, ownerId, currency, amount: amount.toString()},
      reference: collectionId,
      generateLedgerOps: async(ctx) => {
        const planned = await plan(ctx)
        return {
          entries: [{ currency, postings: planned.postings }],
          guardNegative: [accountRef.user(ownerId, currency, 'held-inflow')],
          reversalOf: planned.reversalOf,
          buildResponse: async(post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            collectionId,
            balance: balanceToJson(await post.accountBalance(ownerId, currency))
          }),
          buildEvent: async(post) => this.events(
            eventType,
            collectionId,
            post,
            ownerId,
            currency,
            amount,
            planned.eventMetaData,
            planned.alsoEmit
          )
        }
      }
    })
  }

  private async events(
    type: string,
    collectionId: string,
    post: PostPostingContext,
    ownerId: string,
    currency: string,
    amount: bigint,
    metaData?: Record<string, unknown>,
    alsoEmit: string[] = []
  ): Promise<OutboxEventI[]> {
    const payload = {
      operationId: post.operationId,
      collectionId,
      ownerId,
      currency,
      amount: amount.toString(),
      ...(metaData ?? {}),
      balance: balanceToJson(await post.accountBalance(ownerId, currency)),
    }
    return [type, ...alsoEmit].map((t) => ({ type: t, schemaVersion: 1, payload }));
  }
}