import { Inject, Injectable, Logger } from "@nestjs/common";
import { ClientSession, Types } from "mongoose";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { accountsFromLegacy, LegacyWalletFields, LegacyWalletsService } from "../ledger/legacy-wallets.service";
import { accountRef, System, UserAccountTpe, WalletType } from "../accounts/account";
import { EntryI, OutboxEventType } from "../ledger/types";
import { AppError, ErrorCode } from "../common/errors";
import { Delivery, MESSAGE_QUEUE, QueueName } from "../queue/message-queue";
import type { MessageQueue } from "../queue/message-queue";
import { MigrationsRepository } from "./migrations.repository";
import type { MigrationDoc, MigrationError } from "./migration.schema";

export const CUTOVER_OPERATION = 'migration.cutover';

interface LegacyWalletDoc extends Partial<LegacyWalletFields> {
  _id: Types.ObjectId;
  type: string;
  currency: string;
  createdAt?: Date;
}

export interface CutoverWallet {
  walletType: WalletType;
  currency: string;
  scale: number;
  legacyWalletId: Types.ObjectId;
  mergedWalletIds: Types.ObjectId[];
  accounts: Partial<Record<UserAccountTpe, bigint>>;
}

const toJson = (w: CutoverWallet) => ({
  walletType: w.walletType,
  currency: w.currency,
  legacyWalletId: w.legacyWalletId.toHexString(),
  mergedWalletIds: w.mergedWalletIds.map((id) => id.toHexString()),
  accounts: Object.fromEntries(Object.entries(w.accounts).map(([type, amount]) => [type, amount.toString()])),
});

export interface CutoverResult {
  operationId: string;
  ownerId: string;
  cutoverAt: string;
  wallets: ReturnType<typeof toJson>[];
}

export interface CutoverMessage {
  operationId: string;
}

export const toMigrationView = (m: MigrationDoc) => ({
  operationId: m._id.toHexString(),
  ownerId: m.ownerId,
  status: m.status,
  attempts: m.attempts,
  result: m.result,
  error: m.error,
  createdAt: m.createdAt.toISOString(),
  startedAt: m.startedAt?.toISOString() ?? null,
  finishedAt: m.finishedAt?.toISOString() ?? null,
});

export type CutoverMigrationView = ReturnType<typeof toMigrationView>;

@Injectable()
export class CutoverService {
  private readonly logger = new Logger(CutoverService.name);

  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService,
    private readonly legacyWallets: LegacyWalletsService,
    private readonly migrations: MigrationsRepository,
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueue,
  ) {}

  async preview(ownerId: string) {
    const wallets = await this.readLegacyWallets(ownerId);
    return { ownerId, alreadyCutOver: await this.legacyWallets.isCutOver(ownerId), wallets: wallets.map(toJson) };
  }

  async request(tenantId: string, idempotencyKey: string, ownerId: string): Promise<CutoverMigrationView> {
    const existing = await this.migrations.findByKey(tenantId, idempotencyKey);
    if (existing) return this.resume(existing, ownerId);

    if (await this.legacyWallets.isCutOver(ownerId)) throw AppError.alreadyCutOver(ownerId);
    await this.readLegacyWallets(ownerId);

    const created = await this.migrations.create(tenantId, idempotencyKey, ownerId);
    if (!created) return this.resume((await this.migrations.findByKey(tenantId, idempotencyKey))!, ownerId);
    await this.enqueue(created);
    return toMigrationView(created);
  }

  async get(tenantId: string, operationId: string): Promise<CutoverMigrationView> {
    const migration = await this.migrations.get(operationId, tenantId);
    if (!migration) throw AppError.notFound('No cutover with this operationId', { operationId });
    return toMigrationView(migration);
  }

  async process(message: unknown, delivery: Delivery): Promise<void> {
    const operationId = (message as Partial<CutoverMessage> | null)?.operationId;
    const migration = typeof operationId === 'string' && Types.ObjectId.isValid(operationId)
      ? await this.migrations.markProcessing(new Types.ObjectId(operationId))
      : null;
    if (!migration) {
      this.logger.warn(`Skipping cutover message ${JSON.stringify(message)}: no pending cutover`);
      return;
    }

    let result: CutoverResult;
    try {
      result = await this.cutover(migration);
    } catch (err) {
      const error = describeError(err);
      if (error.retryable && !delivery.lastAttempt) throw err;
      this.logger.error(`Cutover ${operationId} for ${migration.ownerId} failed: ${error.code} ${error.message}`);
      await this.migrations.markFailed(migration._id, error);
      return;
    }
    await this.migrations.markCompleted(migration._id, result);
    this.logger.log(`Cutover ${operationId} for ${migration.ownerId} completed`);
  }

  private async resume(migration: MigrationDoc, ownerId: string): Promise<CutoverMigrationView> {
    if (migration.ownerId !== ownerId) throw AppError.IdempotencyKeyReuse(migration.idempotencyKey);
    if (migration.status === 'completed') return toMigrationView(migration);
    const queued = (await this.migrations.requeue(migration._id)) ?? migration;
    await this.enqueue(queued);
    return toMigrationView(queued);
  }

  private async enqueue(migration: MigrationDoc): Promise<void> {
    const message: CutoverMessage = { operationId: migration._id.toHexString() };
    await this.queue.publish(QueueName.LedgerCutover, message);
  }

  private async cutover(migration: MigrationDoc): Promise<CutoverResult> {
    const { tenantId, idempotencyKey, ownerId } = migration;
    const reference = `migration:${ownerId}`;
    return this.ledgerService.post<CutoverResult>({
      tenantId,
      idempotencyKey,
      operationId: migration._id.toHexString(),
      operationType: CUTOVER_OPERATION,
      requestPayload: { ownerId },
      reference,
      generateLedgerOps: async (ctx) => {
        if (await this.legacyWallets.isCutOver(ownerId, ctx.session)) throw AppError.alreadyCutOver(ownerId);
        const wallets = await this.readLegacyWallets(ownerId, ctx.session);
        for (const w of wallets) {
          // Provisions the accounts; an owner already trading on the ledger can't be seeded on top.
          const existing = await ctx.readBalance(ownerId, w.currency, w.walletType);
          const used = Object.entries(existing).some(([, value]) => typeof value === 'bigint' && value !== 0n);
          if (used) throw AppError.alreadyCutOver(ownerId);
        }
        const cutoverAt = new Date();
        return {
          entries: wallets.flatMap((w) => seedEntries(ownerId, w, reference)),
          sideEffect: async (post) => {
            await this.markLegacyWallets(wallets, post.operationId, cutoverAt, ctx.session);
            // Every wallet, not only those the seed posted to: a zero total can still hide non-zero partitions.
            await this.legacyWallets.updateFromLedger(tenantId, wallets.map((w) => ({ ownerId, currency: w.currency, walletType: w.walletType })), ctx.session);
          },
          buildResponse: (post) => ({ operationId: post.operationId, ownerId, cutoverAt: cutoverAt.toISOString(), wallets: wallets.map(toJson) }),
          buildEvent: (post) => ({
            type: OutboxEventType.LEDGER_CUTOVER,
            schemaVersion: 1,
            payload: { operationId: post.operationId, ownerId, cutoverAt: cutoverAt.toISOString(), wallets: wallets.map(toJson) },
          }),
        };
      },
    });
  }

  /** The owner's legacy documents, one wallet per (type, currency). The oldest document is the one kept. */
  private async readLegacyWallets(ownerId: string, session?: ClientSession): Promise<CutoverWallet[]> {
    const docs = (await this.legacyWallets.collection()
      .find({ merchantId: new Types.ObjectId(ownerId) }, { session })
      .sort({ createdAt: 1, _id: 1 })
      .toArray()) as unknown as LegacyWalletDoc[];
    if (docs.length === 0) throw AppError.notFound('No legacy wallets found for this owner', { ownerId });

    const wallets = new Map<string, CutoverWallet>();
    for (const doc of docs) {
      const walletType: WalletType = doc.type === 'payout' ? 'payout' : 'collection';
      const currency = String(doc.currency).toUpperCase();
      const key = `${walletType}\0${currency}`;
      const { scale } = await this.currencies.require(currency);
      const wallet = wallets.get(key) ?? { walletType, currency, scale, legacyWalletId: doc._id, mergedWalletIds: [], accounts: {} };
      if (!doc._id.equals(wallet.legacyWalletId)) wallet.mergedWalletIds.push(doc._id);
      for (const [type, amount] of Object.entries(accountsFromLegacy(doc as LegacyWalletFields, scale))) {
        wallet.accounts[type as UserAccountTpe] = (wallet.accounts[type as UserAccountTpe] ?? 0n) + amount;
      }
      wallets.set(key, wallet);
    }
    return [...wallets.values()];
  }

  private async markLegacyWallets(wallets: CutoverWallet[], operationId: string, cutoverAt: Date, session: ClientSession): Promise<void> {
    const legacy = this.legacyWallets.collection();
    for (const w of wallets) {
      await legacy.updateOne({ _id: w.legacyWalletId }, { $set: { ledgerCutover: { cutoverAt, operationId }, isLedgerProcessed: true } }, { session });
      if (w.mergedWalletIds.length === 0) continue;
      await legacy.updateMany(
        { _id: { $in: w.mergedWalletIds } },
        {
          $set: {
            availableBalance: 0, ledgerBalance: 0, lienBalance: 0, refundsOrChargeBackBalance: 0, rollingReserveOverdraftBalance: 0,
            ledgerCutover: { cutoverAt, operationId, mergedInto: w.legacyWalletId },
            isLedgerProcessed: false,
            updatedAt: cutoverAt,
          },
        },
        { session },
      );
    }
  }
}

function describeError(err: unknown): MigrationError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, retryable: err.retryable, ...(err.details ? { details: err.details } : {}) };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err), retryable: true };
}

export function seedEntries(ownerId: string, wallet: CutoverWallet, reference: string): EntryI[] {
  const opening = accountRef.system(System.openingBalance, wallet.currency);
  return Object.entries(wallet.accounts)
    .filter(([, amount]) => amount !== 0n)
    .map(([type, amount]) => {
      const account = accountRef.user(ownerId, wallet.currency, wallet.walletType, type as UserAccountTpe);
      const [from, to] = amount > 0n ? [opening, account] : [account, opening];
      const magnitude = amount > 0n ? amount : -amount;
      return {
        currency: wallet.currency,
        reference,
        metadata: { legacyWalletId: wallet.legacyWalletId.toHexString(), accountType: type },
        postings: [
          { account: from, direction: 'debit' as const, amount: magnitude },
          { account: to, direction: 'credit' as const, amount: magnitude },
        ],
      };
    });
}
