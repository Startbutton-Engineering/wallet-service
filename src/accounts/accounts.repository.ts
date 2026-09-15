import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model } from "mongoose";
import { AccountDoc, systemAccountId, USER_ACCOUNT_TYPES, userAccountId, WalletType } from "./account";
import { Account } from "./account.schema";
import { fromDecimal128, toDecimal128 } from "../common/money";
import { WalletBalance } from "../wallets/dto";

@Injectable()
export class AccountsRepository implements OnModuleInit {
  constructor(@InjectModel(Account.name) private readonly model: Model<AccountDoc>) {}

  async onModuleInit(): Promise<void> {
    await this.model.createCollection().catch(() => undefined);
    await this.model.syncIndexes().catch(() => undefined);
  }

  /** Provision user sub-accounts if they do not already exist.
   * Idempotent: safe to call from both explicit open-wallet and lazy auto-provisioning.
   * Runs inside session when provided so it can be part of a transaction
   */
  async ensureUserWallet(
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType,
    session?: ClientSession
  ): Promise<void> {
    const now = new Date();
    const ops = USER_ACCOUNT_TYPES.map((accountType) => {
      const _id = userAccountId(tenantId, ownerId, currency, walletType, accountType);
      return {
        updateOne: {
          filter: { _id },
          update: {
            $setOnInsert: {
              tenantId,
              ownerId,
              currency,
              walletType,
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
    await this.model.bulkWrite(ops, { session })
  }

  async ensureSystem(
    tenantId: string,
    name: string,
    currency: string,
    session?: ClientSession
  ): Promise<void> {
    const _id = systemAccountId(tenantId, name, currency);
    const now = new Date();
    await this.model.updateOne(
      { _id },
      {
        $setOnInsert: {
          tenantId,
          ownerId: null,
          currency,
          walletType: null,
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
    return this.model.findOne({ _id: id }, null, { session }).lean<AccountDoc>().exec()
  }

  async exists(
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType
  ): Promise<boolean> {
    const id = userAccountId(tenantId, ownerId, currency, walletType, 'available')
    return (await this.model.exists({ _id: id })) !== null
  }

  async balanceBreakdown(
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType,
    session?: ClientSession
  ): Promise<WalletBalance | null> {
    const docs = await this.model
      .find({ tenantId, ownerId, currency, walletType, kind: 'user' }, null, { session })
      .lean<AccountDoc[]>()
      .exec();
    if (docs.length === 0) return null;
    console.log(docs)
    const types = new Map(docs.map((d) => [d.accountType, fromDecimal128(d.balance)]))
    console.log(types)
    const available = types.get('available') ?? 0n;
    const heldInflow = types.get('held-inflow') ?? 0n;
    const heldOutflow = types.get('held-outflow') ?? 0n;
    const reserve = types.get('reserve') ?? 0n;
    const refundChargeback = types.get('refund-chargeback') ?? 0n;

    return {
      tenantId,
      ownerId,
      currency,
      walletType,
      available,
      heldInflow,
      heldOutflow,
      reserve,
      ledger: available + heldInflow + heldOutflow + reserve,
      refundChargeback
    }
  }
}
