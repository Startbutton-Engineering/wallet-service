import { Injectable } from "@nestjs/common";
import { LedgerService, PostPostingContext, PrePostContext } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType, OutboxEventI, EntryI } from "../ledger/types";
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

export interface BatchCollectionItem {
  collectionId: string;
  amount: bigint;
}

interface BatchCollectionParams {
  tenantId: string;
  idempotencyKey: string;
  ownerId: string;
  currency: string;
  items: BatchCollectionItem[];
}

export interface BatchCollectionResult {
  operationId: string;
  items: {
    collectionId: string;
    entryId: string;
    amountToCredit: string;
    settledToDebit: string;
  }[];
  balance: ReturnType<typeof balanceToJson>
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
        entries: [{
          currency,
          postings: [
            { account: accountRef.collection(currency), direction: 'debit', amount},
            { account: accountRef.user(ownerId, currency, 'held-inflow'), direction: 'credit', amount}
          ]
        }]
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
        entries: [{
          currency,
          postings: [
            { account: accountRef.user(ownerId, currency, 'held-inflow'), direction: 'debit', amount },
            ...postings
          ]
        }],
        eventMetaData: {
          settledToDebit: settled.toString(),
          amountToCredit: amountToCredit.toString(),
        },
        alsoEmit: settled > 0n ? ['ReffunChargebackSettled'] : []
      }
    })
  }

  async settleBatch(params: BatchCollectionParams): Promise<BatchCollectionResult> {
    const { tenantId, idempotencyKey, ownerId, currency, items } = params;
    await this.currencies.require(currency);

    return this.ledgerService.post<BatchCollectionResult>({
      tenantId,
      idempotencyKey,
      operationType: 'collection.settle.batch',
      requestPayload: {
        ownerId,
        currency,
        items: items.map((i) => ({ collectionId: i.collectionId, amount: i.amount.toString() })),
      },
      generateLedgerOps: async (ctx) => {
        const current = await ctx.readBalance(ownerId, currency);
        let runningRefundChargeback = current.refundChargeback;
        const entries: EntryI[] = [];
        const perItem: BatchCollectionResult['items'] = [];

        for (const item of items) {
          const outstanding = await ctx.referenceNetAmount(
            item.collectionId,
            accountRef.user(ownerId, currency, 'held-inflow'),
          );
          if (item.amount > outstanding) {
            throw AppError.collectionOverSettlement({
              collectionId: item.collectionId,
              requested: item.amount.toString(),
              outstanding: outstanding.toString(),
            });
          }

          const { postings, settled, amountToCredit } = creditWithDebtPaydown({
            ownerId,
            currency,
            amount: item.amount,
            refundChargeBackBalance: runningRefundChargeback,
          });
          runningRefundChargeback += settled;

          entries.push({
            currency,
            reference: item.collectionId,
            postings: [
              { account: accountRef.user(ownerId, currency, 'held-inflow'), direction: 'debit', amount: item.amount },
              ...postings,
            ],
          });
          perItem.push({
            collectionId: item.collectionId,
            entryId: '', // filled in from post.entryIds once entries are posted, see buildResponse
            amountToCredit: amountToCredit.toString(),
            settledToDebit: settled.toString(),
          });
        }

        const settledAny = perItem.some((p) => p.settledToDebit !== '0');

        return {
          entries,
          guardNegative: [accountRef.user(ownerId, currency, 'held-inflow')],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            items: perItem.map((p, i) => ({ ...p, entryId: post.entryIds[i] })),
            balance: balanceToJson(await post.accountBalance(ownerId, currency)),
          }),
          buildEvent: async (post) => this.events(
            OutboxEventType.COLLECTION_SETTLED,
            null,
            post,
            ownerId,
            currency,
            items.reduce((sum, i) => sum + i.amount, 0n),
            { items: perItem },
            settledAny ? ['ReffunChargebackSettled'] : [],
          ),
        };
      },
    });
  }

  private async post(
    params: CollectionParams,
    operationType: string,
    eventType: OutboxEventType,
    plan: (ctx: PrePostContext) => Promise<{
      entries: EntryI[];
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
          entries: planned.entries,
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
    collectionId: string | null,
    post: PostPostingContext,
    ownerId: string,
    currency: string,
    amount: bigint,
    metaData?: Record<string, unknown>,
    alsoEmit: string[] = []
  ): Promise<OutboxEventI[]> {
    const payload = {
      operationId: post.operationId,
      ...(collectionId ? { collectionId } : {}),
      ownerId,
      currency,
      amount: amount.toString(),
      ...(metaData ?? {}),
      balance: balanceToJson(await post.accountBalance(ownerId, currency)),
    }
    return [type, ...alsoEmit].map((t) => ({ type: t, schemaVersion: 1, payload }));
  }
}