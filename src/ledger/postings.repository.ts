import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, QueryFilter, Types } from "mongoose";
import { Posting } from "./schemas/posting.schema";
import { PostingDoc } from "./types";
import type { WalletType } from "../accounts/account";

export interface SequenceRange {
  fromSeq?: number;
  toSeq?: number;
}

export interface AccountPageQuery extends SequenceRange {
  accountId: Types.ObjectId;
  /** Exclusive: the last sequence the previous page returned. */
  afterSeq?: number;
  limit: number;
}

export interface OwnerPageQuery {
  tenantId: string;
  ownerId: string;
  currency: string;
  walletType?: WalletType;
  accountType?: string;
  from?: Date;
  to?: Date;
  /** Exclusive: the (createdAt, _id) of the last row the previous page returned. */
  after?: { createdAt: Date; id: string };
  limit: number;
}

@Injectable()
export class PostingsRepository {
  constructor(@InjectModel(Posting.name) private readonly model: Model<PostingDoc>) {}

  /** Turns a time window into the account's sequence window, so paging by sequence never
   * reads history outside it. Returns null when nothing in the account falls inside the window.
   * Each bound is one index seek on { accountId, createdAt, sequence }, which also serves the
   * sequence tiebreak so neither lookup sorts in memory. */
  async sequenceBounds(accountId: Types.ObjectId, from?: Date, to?: Date): Promise<SequenceRange | null> {
    const range: SequenceRange = {};
    if (from) {
      const first = await this.model
        .findOne({ accountId, createdAt: { $gte: from } })
        .sort({ createdAt: 1, sequence: 1 })
        .select({ sequence: 1 })
        .lean<Pick<PostingDoc, 'sequence'>>()
        .exec();
      if (!first || first.sequence === null) return null;
      range.fromSeq = first.sequence;
    }
    if (to) {
      const last = await this.model
        .findOne({ accountId, createdAt: { $lte: to } })
        .sort({ createdAt: -1, sequence: -1 })
        .select({ sequence: 1 })
        .lean<Pick<PostingDoc, 'sequence'>>()
        .exec();
      if (!last || last.sequence === null) return null;
      range.toSeq = last.sequence;
    }
    if (range.fromSeq !== undefined && range.toSeq !== undefined && range.fromSeq > range.toSeq) return null;
    return range;
  }

  /** One account's postings in sequence order. Served by { accountId, sequence }. */
  async pageByAccount(q: AccountPageQuery): Promise<PostingDoc[]> {
    const sequence: Record<string, number> = {};
    if (q.fromSeq !== undefined) sequence.$gte = q.fromSeq;
    if (q.toSeq !== undefined) sequence.$lte = q.toSeq;
    if (q.afterSeq !== undefined) sequence.$gt = q.afterSeq;

    const filter: QueryFilter<PostingDoc> = { accountId: q.accountId };
    if (Object.keys(sequence).length > 0) filter.sequence = sequence;

    return this.model
      .find(filter)
      .sort({ sequence: 1 })
      .limit(q.limit)
      .lean<PostingDoc[]>()
      .exec();
  }

  /** An owner's postings across sub-accounts in one currency, in (createdAt, _id) order.
   * Served by { tenantId, ownerId, currency, createdAt, _id }; walletType/accountType are
   * residual filters within that owner and currency. */
  async pageByOwner(q: OwnerPageQuery): Promise<PostingDoc[]> {
    const filter: QueryFilter<PostingDoc> = {
      tenantId: q.tenantId,
      ownerId: q.ownerId,
      currency: q.currency,
      kind: 'user',
    };
    if (q.walletType) filter.walletType = q.walletType;
    if (q.accountType) filter.accountType = q.accountType;

    const createdAt: Record<string, Date> = {};
    if (q.from) createdAt.$gte = q.from;
    if (q.to) createdAt.$lte = q.to;
    if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

    if (q.after) {
      const afterId = new Types.ObjectId(q.after.id);
      filter.$or = [
        { createdAt: { $gt: q.after.createdAt } },
        { createdAt: q.after.createdAt, _id: { $gt: afterId } },
      ];
    }

    return this.model
      .find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(q.limit)
      .lean<PostingDoc[]>()
      .exec();
  }

  async findByIds(ids: Types.ObjectId[]): Promise<PostingDoc[]> {
    if (ids.length === 0) return [];
    return this.model
      .find({ _id: { $in: ids } })
      .lean<PostingDoc[]>()
      .exec();
  }
}
