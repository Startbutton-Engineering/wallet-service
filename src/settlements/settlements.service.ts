import { Injectable } from "@nestjs/common";
import { WalletType } from "../accounts/account";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { EntriesRepository } from "../ledger/entries.repository";
import { LedgerService, LedgerOperation, PostPostingContext } from "../ledger/ledger.service";
import { OutboxEventType } from "../ledger/types";
import { balanceToJson } from "../wallets/dto";
import {
  SETTLEMENT_TRANSITIONS,
  SettlementOperation,
  SettlementPlan,
  SettlementResolution,
  planInitiate,
} from "./settlement-transitions";

export interface SettlementResult {
  operationId: string;
  entryId: string;
  settlementId: string;
  status: 'initiated' | SettlementResolution;
  currency: string;
  amount: string;
  walletType: WalletType;
  balance: ReturnType<typeof balanceToJson>;
}

export interface PendingSettlementSummary {
  settlementId: string;
  ownerId: string;
  currency: string;
  amount: string;
  walletType: WalletType;
  initiatedAt: Date;
}

interface InitiateSettlementParams {
  tenantId: string;
  idempotencyKey: string;
  settlementId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  walletType: WalletType;
}

interface ResolveSettlementParams {
  tenantId: string;
  idempotencyKey: string;
  settlementId: string;
  ownerId: string;
  currency: string;
  status: SettlementResolution;
  walletType: WalletType;
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService,
    private readonly entriesRepo: EntriesRepository,
  ) {}

  async initiate(params: InitiateSettlementParams): Promise<SettlementResult> {
    const { tenantId, idempotencyKey, settlementId, ownerId, currency, amount, walletType } = params;
    await this.currencies.require(currency);

    return this.ledgerService.post<SettlementResult>({
      tenantId,
      idempotencyKey,
      operationType: SettlementOperation.initiate,
      requestPayload: { settlementId, ownerId, currency, amount: amount.toString(), walletType },
      reference: settlementId,
      generateLedgerOps: async (ctx) => {
        const plan = await planInitiate(ctx, { settlementId, ownerId, currency, amount, walletType });
        return this.operation(plan, OutboxEventType.SETTLEMENT_INITIATED, {
          settlementId, ownerId, currency, walletType, status: 'initiated', amount,
        });
      },
    });
  }

  /** Amounts are always read back from the hold made at initiate, never resupplied. */
  async resolve(params: ResolveSettlementParams): Promise<SettlementResult> {
    const { tenantId, idempotencyKey, settlementId, ownerId, currency, status, walletType } = params;
    await this.currencies.require(currency);
    const transition = SETTLEMENT_TRANSITIONS[status];

    return this.ledgerService.post<SettlementResult>({
      tenantId,
      idempotencyKey,
      operationType: transition.operationType,
      requestPayload: { settlementId, ownerId, currency, status, walletType },
      reference: settlementId,
      generateLedgerOps: async (ctx) => {
        const plan = await transition.plan(ctx, { settlementId, ownerId, currency, walletType });
        const amount = plan.entries[0].postings[0].amount;
        return this.operation(plan, transition.eventType, {
          settlementId, ownerId, currency, walletType, status, amount,
        });
      },
    });
  }

  /** Settlements with no status document: this reconstructs "awaiting approval" from the
   * ledger by finding initiate entries whose reference has no success/failed entry yet. */
  async listPending(tenantId: string, limit?: number): Promise<PendingSettlementSummary[]> {
    const rows = await this.entriesRepo.findUnresolvedInitiations(
      tenantId,
      SettlementOperation.initiate,
      [SettlementOperation.success, SettlementOperation.failed],
      { limit },
    );
    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, string>;
      return {
        settlementId: r.reference as string,
        ownerId: meta.ownerId,
        currency: meta.currency,
        amount: meta.amount,
        walletType: (meta.walletType ?? 'collection') as WalletType,
        initiatedAt: r.createdAt,
      };
    });
  }

  private operation(
    plan: SettlementPlan,
    eventType: OutboxEventType,
    s: {
      settlementId: string;
      ownerId: string;
      currency: string;
      walletType: WalletType;
      status: SettlementResult['status'];
      amount: bigint;
    },
  ): LedgerOperation<SettlementResult> {
    const result = async (post: PostPostingContext): Promise<SettlementResult> => ({
      operationId: post.operationId,
      entryId: post.entryIds[0],
      settlementId: s.settlementId,
      status: s.status,
      currency: s.currency,
      amount: s.amount.toString(),
      walletType: s.walletType,
      balance: balanceToJson(await post.accountBalance(s.ownerId, s.currency, s.walletType)),
    });

    return {
      entries: plan.entries,
      guardNegative: plan.guardNegative,
      buildResponse: result,
      buildEvent: async (post) => ({
        type: eventType,
        schemaVersion: 1,
        payload: { ...(await result(post)), ownerId: s.ownerId },
      }),
    };
  }
}
