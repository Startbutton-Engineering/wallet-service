import { Inject, Injectable } from "@nestjs/common";
import { ClientSession, Types, mongo } from "mongoose";
import { CONFIG } from "../config";
import type { AppConfig } from "../config";
import { DatabaseService } from "../database/database.service";
import { AccountsRepository } from "../accounts/accounts.repository";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { UserAccountTpe, WalletType } from "../accounts/account";
import { WalletBalance } from "../wallets/dto";
import { AppError } from "../common/errors";

export interface LegacyWalletFields {
  availableBalance: number;
  ledgerBalance: number;
  lienBalance: number;
  refundsOrChargeBackBalance: number;
  rollingReserveOverdraftBalance: number;
}

export interface WalletKey { ownerId: string; currency: string; walletType: WalletType }

export function majorToMinor(amount: unknown, scale: number): bigint {
  const value = amount === undefined || amount === null ? 0 : Number(amount);
  if (!Number.isFinite(value)) throw new Error(`Legacy amount is not a finite number: ${String(amount)}`);
  const magnitude = BigInt(Math.abs(value).toFixed(scale).replace('.', ''));
  return value < 0 ? -magnitude : magnitude;
}

export function minorToMajor(minor: bigint, scale: number): number {
  const digits = (minor < 0n ? -minor : minor).toString().padStart(scale + 1, '0');
  const major = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return Number(minor < 0n ? `-${major}` : major);
}

export function accountsFromLegacy(fields: LegacyWalletFields, scale: number): Partial<Record<UserAccountTpe, bigint>> {
  const available = majorToMinor(fields.availableBalance, scale);
  const ledger = majorToMinor(fields.ledgerBalance, scale);
  const lien = majorToMinor(fields.lienBalance, scale);
  return {
    available: available - lien,
    lien,
    'legacy-pending': ledger - available,
    'refund-chargeback': majorToMinor(fields.refundsOrChargeBackBalance, scale),
    'reserve-overdraft': majorToMinor(fields.rollingReserveOverdraftBalance, scale),
  };
}

export function legacyFieldsFromBalance(balance: WalletBalance, scale: number): LegacyWalletFields {
  const available = balance.available + balance.lien;
  return {
    availableBalance: minorToMajor(available, scale),
    ledgerBalance: minorToMajor(available + balance.heldInflow + balance.heldOutflow + balance.legacyPending, scale),
    lienBalance: minorToMajor(balance.lien, scale),
    refundsOrChargeBackBalance: minorToMajor(balance.refundChargeback, scale),
    rollingReserveOverdraftBalance: minorToMajor(balance.reserveOverdraft, scale),
  };
}

@Injectable()
export class LegacyWalletsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly accounts: AccountsRepository,
    private readonly currencies: CurrencyRegistryService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  collection(name = 'wallets'): mongo.Collection {
    if (!this.config.legacyDbName) throw AppError.legacyWalletUpdateFailed('LEGACY_DB_NAME is not configured');
    return this.database.conn.getClient().db(this.config.legacyDbName).collection(name);
  }

  async findLedgerProcessed(wallet: WalletKey, session?: ClientSession): Promise<{ _id: Types.ObjectId; scale: number } | null> {
    if (!this.config.legacyDbName || !Types.ObjectId.isValid(wallet.ownerId)) return null;
    const doc = await this.collection().findOne(
      {
        merchantId: new Types.ObjectId(wallet.ownerId),
        currency: wallet.currency,
        type: wallet.walletType,
        isLedgerProcessed: true,
      },
      { session, projection: { _id: 1 }, sort: { createdAt: 1, _id: 1 } },
    );
    if (!doc) return null;
    return { _id: doc._id as Types.ObjectId, scale: (await this.currencies.require(wallet.currency)).scale };
  }

  async cutoverAt(ownerId: string, session?: ClientSession): Promise<Date | null> {
    if (!this.config.legacyDbName || !Types.ObjectId.isValid(ownerId)) return null;
    const doc = await this.collection().findOne(
      { merchantId: new Types.ObjectId(ownerId), 'ledgerCutover.cutoverAt': { $exists: true } },
      { session, projection: { 'ledgerCutover.cutoverAt': 1 } },
    );
    return (doc?.ledgerCutover?.cutoverAt as Date | undefined) ?? null;
  }

  async isCutOver(ownerId: string, session?: ClientSession): Promise<boolean> {
    const doc = await this.collection().findOne(
      { merchantId: new Types.ObjectId(ownerId), 'ledgerCutover.cutoverAt': { $exists: true } },
      { session, projection: { _id: 1 } },
    );
    return doc !== null;
  }

  /** Rewrites the legacy document of each ledger-processed wallet among `wallets` from its ledger balance. */
  async updateFromLedger(tenantId: string, wallets: WalletKey[], session: ClientSession): Promise<void> {
    const unique = new Map(wallets.map((w) => [`${w.ownerId}\0${w.currency}\0${w.walletType}`, w]));
    for (const wallet of unique.values()) {
      const legacy = await this.findLedgerProcessed(wallet, session);
      if (!legacy) continue;
      const balance = await this.accounts.balanceBreakdown(tenantId, wallet.ownerId, wallet.currency, wallet.walletType, session);
      if (!balance) throw AppError.legacyWalletUpdateFailed('Ledger-processed wallet has no ledger accounts', { ...wallet });
      const now = new Date();
      await this.collection().updateOne(
        { _id: legacy._id },
        { $set: { ...legacyFieldsFromBalance(balance, legacy.scale), 'ledgerCutover.updatedAt': now, updatedAt: now } },
        { session },
      );
    }
  }
}
