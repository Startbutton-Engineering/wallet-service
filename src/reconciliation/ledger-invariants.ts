import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, PipelineStage, Types } from "mongoose";
import { Account } from "../accounts/account.schema";
import { AccountDoc } from "../accounts/account";
import { Posting } from "../ledger/schemas/posting.schema";
import { PostingDoc } from "../ledger/types";
import { fromDecimal128 } from "../common/money";

/** A posting's amount under the sign convention balance = credits − debits. */
export const SIGNED_AMOUNT = {
  $cond: [
    { $eq: ['$direction', 'credit'] },
    '$amount',
    { $multiply: ['$amount', Types.Decimal128.fromString('-1')] },
  ],
};

export interface TrialBalanceRow {
  tenantId: string;
  currency: string;
  /** Sum of materialized account balances. */
  balancesNet: bigint;
  /** Sum of every posting ever written. */
  postingsNet: bigint;
}

export interface UnbalancedEntry {
  tenantId: string;
  entryId: string;
  currency: string;
  net: bigint;
}

type Grouped<K> = { _id: K; net: Types.Decimal128 };

@Injectable()
export class LedgerInvariants {
  constructor(
    @InjectModel(Account.name) private readonly accounts: Model<AccountDoc>,
    @InjectModel(Posting.name) private readonly postings: Model<PostingDoc>,
  ) {}

  /** Per tenant × currency; every row must net to zero on both sides. */
  async trialBalance(): Promise<TrialBalanceRow[]> {
    type Key = { tenantId: string; currency: string };
    const byBalances = await this.snapshotAggregate<Grouped<Key>>(this.accounts, [
      { $group: { _id: { tenantId: '$tenantId', currency: '$currency' }, net: { $sum: '$balance' } } },
    ]);
    const byPostings = await this.snapshotAggregate<Grouped<Key>>(this.postings, [
      { $group: { _id: { tenantId: '$tenantId', currency: '$currency' }, net: { $sum: SIGNED_AMOUNT } } },
    ]);

    const rows = new Map<string, TrialBalanceRow>();
    const row = (k: Key) => {
      const id = `${k.tenantId}\0${k.currency}`;
      if (!rows.has(id)) rows.set(id, { tenantId: k.tenantId, currency: k.currency, balancesNet: 0n, postingsNet: 0n });
      return rows.get(id)!;
    };
    for (const g of byBalances) row(g._id).balancesNet = fromDecimal128(g.net);
    for (const g of byPostings) row(g._id).postingsNet = fromDecimal128(g.net);
    return [...rows.values()].sort(
      (a, b) => a.tenantId.localeCompare(b.tenantId) || a.currency.localeCompare(b.currency),
    );
  }

  /** Entries whose postings do not net to zero: the operation that broke double entry. */
  async unbalancedEntries(): Promise<UnbalancedEntry[]> {
    const groups = await this.snapshotAggregate<
      Grouped<Types.ObjectId> & { tenantId: string; currency: string }
    >(this.postings, [
      {
        $group: {
          _id: '$entryId',
          net: { $sum: SIGNED_AMOUNT },
          tenantId: { $first: '$tenantId' },
          currency: { $first: '$currency' },
        },
      },
      { $match: { net: { $ne: Types.Decimal128.fromString('0') } } },
      { $sort: { _id: 1 } },
    ]);
    return groups.map((g) => ({
      tenantId: g.tenantId,
      entryId: g._id.toHexString(),
      currency: g.currency,
      net: fromDecimal128(g.net),
    }));
  }

  private snapshotAggregate<T>(model: Model<AccountDoc> | Model<PostingDoc>, pipeline: PipelineStage[]): Promise<T[]> {
    return (model as Model<unknown>).aggregate<T>(pipeline).readConcern('snapshot').allowDiskUse(true).exec();
  }
}
