import { Injectable, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AccountDoc, systemAccountId, USER_ACCOUNT_TYPES, userAccountId } from "./account";
import { ClientSession } from "mongodb";
import { fromDecimal128, toDecimal128 } from "../common/money";
import { WalletBalance } from "../wallets/dto";

const COLLECTION = 'accounts';

@Injectable()
export class AccountsRepository implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}

  private collection() {
    return this.db.collection<AccountDoc>(COLLECTION)
  }

  async onModuleInit(): Promise<void> {
    await this.collection().createIndex({ tenantId: 1, ownerId: 1, currency: 1, accountType: 1 });
    await this.collection().createIndex({ tenantId: 1, kind: 1, currency: 1 })
  }

  /** Provision user sub-accounts if they do not already exist.
   * Idempotent: safe to call from both explicit open-wallet and lazy auto-provisioning.
   * Runs inside session when provided so it can be part of a transaction
   */
  async ensureUserWallet(
    tenantId: string,
    ownerId: string,
    currency: string,
    session?: ClientSession
  ): Promise<void> {
    const now = new Date();
    const ops = USER_ACCOUNT_TYPES.map((accountType) => {
      const _id = userAccountId(tenantId, ownerId, currency, accountType);
      return {
        updateOne: {
          filter: { _id },
          update: {
            $setOnInsert: {
              _id,
              tenantId,
              ownerId,
              currency,
              accountType,
              kind: 'user' as const,
              balance: toDecimal128(0n),
              version: 0,
              sequence: 0,
              createdAt: now,
              updatedAt: now
            },
          },
          upsert: true,
        }
      };
    });
    await this.collection().bulkWrite(ops, { session })
  }

  async ensureSystem(
    tenantId: string,
    name: string,
    currency: string,
    session?: ClientSession
  ): Promise<void> {
    const _id = systemAccountId(tenantId, name, currency);
    const now = new Date();
    await this.collection().updateOne(
      { _id },
      {
        $setOnInsert: {
          _id,
          tenantId,
          ownerId: null,
          currency,
          accountType: name,
          kind: 'system' as const,
          balance: toDecimal128(0n),
          version: 0,
          sequence: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, session }
    )
  }

  async findById(id: string, session?: ClientSession): Promise<AccountDoc | null> {
    return this.collection().findOne({ _id: id }, { session })
  }

  async exists(tenantId: string, ownerId: string, currency: string): Promise<boolean> {
    const id = userAccountId(tenantId, ownerId, currency, 'available')
    return ( await this.collection().countDocuments({ _id: id }, { limit: 1 }) ) > 0
  }

  async balanceBreakdown(tenantId: string, ownerId: string, currency: string): Promise<WalletBalance | null> {
    const docs = await this.collection()
      .find({ tenantId, ownerId, currency, kind: 'user' })
      .toArray();
    if (docs.length === 0) return null;

    const types = new Map(docs.map((d) => [d.accountType, fromDecimal128(d.balance)]))
    const available = types.get('available') ?? 0n;
    const heldInflow = types.get('held-inflow') ?? 0n;
    const heldOutflow = types.get('held-outflow') ?? 0n;
    const reserve = types.get('reserve') ?? 0n;
    const refundChargeback = types.get('refund-chargeback') ?? 0n;

    return {
      tenantId,
      ownerId,
      currency,
      available,
      heldInflow,
      heldOutflow,
      reserve,
      ledger: available + heldInflow + heldOutflow + reserve,
      refundChargeback
    }
  }
}