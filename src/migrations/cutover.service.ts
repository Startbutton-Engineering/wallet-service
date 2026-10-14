import { Injectable } from "@nestjs/common";
import { ClientSession, Types } from "mongoose";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { accountsFromLegacy, LegacyWalletFields, LegacyWalletsService } from "../ledger/legacy-wallets.service";
import { accountRef, System, UserAccountTpe, WalletType } from "../accounts/account";
import { EntryI, OutboxEventType } from "../ledger/types";
import { AppError } from "../common/errors";

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

/**
 * Moves an owner's legacy wallets onto the ledger exactly as they are, and marks the legacy
 * documents `ledgerCutover` in the same transaction; from then on every post updates them. A legacy
 * write racing the cutover touches the same documents, so one of the two transactions hits a write
 * conflict and retries: the snapshot is exact without a freeze.
 */
@Injectable()
export class CutoverService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService,
    private readonly legacyWallets: LegacyWalletsService,
  ) {}

  /** The balances a cutover would set, without writing anything. */
  async preview(ownerId: string) {
    const wallets = await this.readLegacyWallets(ownerId);
    return { ownerId, alreadyCutOver: await this.legacyWallets.isCutOver(ownerId), wallets: wallets.map(toJson) };
  }

  async cutover(tenantId: string, idempotencyKey: string, ownerId: string): Promise<CutoverResult> {
    const reference = `migration:${ownerId}`;
    return this.ledgerService.post<CutoverResult>({
      tenantId,
      idempotencyKey,
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

  /** Marks every legacy document as ledger-owned. Other partitions are zeroed and point at the kept document. */
  private async markLegacyWallets(wallets: CutoverWallet[], operationId: string, cutoverAt: Date, session: ClientSession): Promise<void> {
    const legacy = this.legacyWallets.collection();
    for (const w of wallets) {
      await legacy.updateOne({ _id: w.legacyWalletId }, { $set: { ledgerCutover: { cutoverAt, operationId } } }, { session });
      if (w.mergedWalletIds.length === 0) continue;
      await legacy.updateMany(
        { _id: { $in: w.mergedWalletIds } },
        {
          $set: {
            availableBalance: 0, ledgerBalance: 0, lienBalance: 0, refundsOrChargeBackBalance: 0, rollingReserveOverdraftBalance: 0,
            ledgerCutover: { cutoverAt, operationId, mergedInto: w.legacyWalletId },
            updatedAt: cutoverAt,
          },
        },
        { session },
      );
    }
  }
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
