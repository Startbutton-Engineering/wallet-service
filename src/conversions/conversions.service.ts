import { Injectable } from "@nestjs/common";
import { WalletType } from "../accounts/account";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { EntriesRepository } from "../ledger/entries.repository";
import { LedgerService } from "../ledger/ledger.service";
import { OutboxEventType } from "../ledger/types";
import { balanceToJson } from "../wallets/dto";
import {
  CONVERSION_TRANSITIONS,
  ConversionOperation,
  ConversionResolution,
  planInitiate,
} from "./conversion-transitions";

export interface ConversionResult {
  operationId: string;
  entryIds: string[];
  conversionId: string;
  status: 'initiated' | ConversionResolution;
  fromCurrency: string;
  toCurrency: string;
  rate?: string;
  fromAmount: string;
  toAmount: string;
  walletType: WalletType;
  fromBalance: ReturnType<typeof balanceToJson>;
  toBalance: ReturnType<typeof balanceToJson>;
}

export interface PendingConversionSummary {
  conversionId: string;
  ownerId: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  fromAmount: string;
  toAmount: string;
  walletType: WalletType;
  initiatedAt: Date;
}

interface InitiateConversionParams {
  tenantId: string;
  idempotencyKey: string;
  conversionId: string;
  ownerId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: bigint;
  rate: string;
  walletType: WalletType;
}

interface ResolveConversionParams {
  tenantId: string;
  idempotencyKey: string;
  conversionId: string;
  ownerId: string;
  fromCurrency: string;
  toCurrency: string;
  status: ConversionResolution;
  walletType: WalletType;
}

@Injectable()
export class ConversionsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService,
    private readonly entriesRepo: EntriesRepository,
  ) {}

  async initiate(params: InitiateConversionParams): Promise<ConversionResult> {
    const { tenantId, idempotencyKey, conversionId, ownerId, fromCurrency, toCurrency, fromAmount, rate, walletType } = params;
    const from = await this.currencies.require(fromCurrency);
    const to = await this.currencies.require(toCurrency);
    return this.ledgerService.post<ConversionResult>({
      tenantId,
      idempotencyKey,
      operationType: ConversionOperation.initiate,
      requestPayload: { conversionId, ownerId, fromCurrency, toCurrency, fromAmount: fromAmount.toString(), rate, walletType },
      reference: conversionId,
      generateLedgerOps: async (ctx) => {
        const { plan, toAmount } = await planInitiate(ctx, {
          conversionId, ownerId, fromCurrency, toCurrency, fromAmount, rate, walletType,
          fromScale: from.scale, toScale: to.scale,
        });
        return {
          entries: plan.entries,
          guardNegative: plan.guardNegative,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryIds: post.entryIds,
            conversionId,
            status: 'initiated' as const,
            fromCurrency,
            toCurrency,
            rate,
            fromAmount: fromAmount.toString(),
            toAmount: toAmount.toString(),
            walletType,
            fromBalance: balanceToJson(await post.accountBalance(ownerId, fromCurrency, walletType)),
            toBalance: balanceToJson(await post.accountBalance(ownerId, toCurrency, walletType)),
          }),
          buildEvent: async (post) => ({
            type: OutboxEventType.CONVERSION_INITIATED,
            schemaVersion: 1,
            payload: {
              operationId: post.operationId,
              conversionId,
              ownerId,
              fromCurrency,
              toCurrency,
              rate,
              fromAmount: fromAmount.toString(),
              toAmount: toAmount.toString(),
              walletType,
            },
          }),
        };
      },
    });
  }

  async resolve(params: ResolveConversionParams): Promise<ConversionResult> {
    const { tenantId, idempotencyKey, conversionId, ownerId, fromCurrency, toCurrency, status, walletType } = params;
    const transition = CONVERSION_TRANSITIONS[status];

    return this.ledgerService.post<ConversionResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { conversionId, ownerId, fromCurrency, toCurrency, status, walletType },
      reference: conversionId,
      generateLedgerOps: async (ctx) => {
        const plan = await transition.plan(ctx, { conversionId, ownerId, fromCurrency, toCurrency, walletType });
        const fromAmount = plan.entries[0].postings[0].amount;
        const toAmount = plan.entries[1].postings[0].amount;
        return {
          entries: plan.entries,
          guardNegative: plan.guardNegative,
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryIds: post.entryIds,
            conversionId,
            status,
            fromCurrency,
            toCurrency,
            fromAmount: fromAmount.toString(),
            toAmount: toAmount.toString(),
            walletType,
            fromBalance: balanceToJson(await post.accountBalance(ownerId, fromCurrency, walletType)),
            toBalance: balanceToJson(await post.accountBalance(ownerId, toCurrency, walletType)),
          }),
          buildEvent: async (post) => {
            const settledToDebit = plan.settledToDebit ?? 0n;
            const payload = {
              operationId: post.operationId,
              conversionId,
              ownerId,
              fromCurrency,
              toCurrency,
              status,
              fromAmount: fromAmount.toString(),
              toAmount: toAmount.toString(),
              walletType,
              ...(settledToDebit > 0n ? { settledToDebit: settledToDebit.toString() } : {}),
            };
            return [
              transition.eventType,
              ...(settledToDebit > 0n ? [OutboxEventType.REFUND_CHARGEBACK_SETTLED] : []),
            ].map((type) => ({ type, schemaVersion: 1, payload }));
          },
        };
      },
    });
  }

  async listPending(tenantId: string, limit?: number): Promise<PendingConversionSummary[]> {
    const rows = await this.entriesRepo.findUnresolvedInitiations(
      tenantId,
      ConversionOperation.initiate,
      [ConversionOperation.approve, ConversionOperation.reject],
      { limit },
    );
    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, string>;
      return {
        conversionId: r.reference as string,
        ownerId: meta.ownerId,
        fromCurrency: meta.fromCurrency,
        toCurrency: meta.toCurrency,
        rate: meta.rate,
        fromAmount: meta.fromAmount,
        toAmount: meta.toAmount,
        walletType: (meta.walletType ?? 'collection') as WalletType,
        initiatedAt: r.createdAt,
      };
    });
  }
}
