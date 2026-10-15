import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model, mongo, QueryFilter, Types } from "mongoose";
import { Account } from "../accounts/account.schema";
import { AccountDoc } from "../accounts/account";
import { Posting } from "../ledger/schemas/posting.schema";
import { PostingDoc } from "../ledger/types";
import { fromDecimal128 } from "../common/money";
import { SIGNED_AMOUNT } from "./ledger-invariants";

const BATCH_SIZE = 100;

export interface AccountCheck {
  account: AccountDoc;
  expected: bigint;
  actual: bigint;
  postingCount: number;
}

@Injectable()
export class AccountReconciler {
  constructor(
    @InjectModel(Account.name) private readonly accounts: Model<AccountDoc>,
    @InjectModel(Posting.name) private readonly postings: Model<PostingDoc>,
  ) {}

  async *check(filter: QueryFilter<AccountDoc> = {}): AsyncGenerator<AccountCheck[]> {
    let after: Types.ObjectId | null = null;
    for (;;) {
      const batch = await this.snapshot(async (session) => {
        const accounts = await this.accounts
          .find(after ? { ...filter, _id: { $gt: after } } : filter, null, { session })
          .sort({ _id: 1 })
          .limit(BATCH_SIZE)
          .lean<AccountDoc[]>()
          .exec();
        return this.compare(accounts, session);
      });
      if (batch.length === 0) return;
      yield batch;
      after = batch[batch.length - 1].account._id;
    }
  }

  private async compare(accounts: AccountDoc[], session: ClientSession): Promise<AccountCheck[]> {
    if (accounts.length === 0) return [];
    const sums = await this.postings
      .aggregate<{ _id: Types.ObjectId; net: Types.Decimal128; count: number }>(
        [
          { $match: { accountId: { $in: accounts.map((a) => a._id) } } },
          {
            $group: {
              _id: '$accountId',
              net: { $sum: SIGNED_AMOUNT },
              count: { $sum: 1 },
            },
          },
        ],
        { session },
      )
      .exec();
    const byAccount = new Map(sums.map((s) => [s._id.toHexString(), s]));
    return accounts.map((account) => {
      const sum = byAccount.get(account._id.toHexString());
      return {
        account,
        expected: sum ? fromDecimal128(sum.net) : 0n,
        actual: fromDecimal128(account.balance),
        postingCount: sum?.count ?? 0,
      };
    });
  }

  private async snapshot<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.accounts.db.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        { readConcern: { level: 'snapshot' }, readPreference: mongo.ReadPreference.primary },
      );
      return result;
    } finally {
      await session.endSession();
    }
  }
}
