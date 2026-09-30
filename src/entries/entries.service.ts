import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { AppError } from "../common/errors";
import { EntriesRepository } from "../ledger/entries.repository";
import { IdempotencyRepository } from "../ledger/idempotency.repository";
import { PostingsRepository } from "../ledger/postings.repository";
import { EntryDoc, IdempotencyDoc } from "../ledger/types";
import { EntryList, EntryLookup, EntryView, entryView, REFERENCE_OPERATION_TYPES } from "./dto";

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class EntriesService {
  constructor(
    private readonly entries: EntriesRepository,
    private readonly postings: PostingsRepository,
    private readonly idempotency: IdempotencyRepository
  ) {}

  async get(tenantId: string, entryId: string): Promise<EntryView> {
    const entry = OBJECT_ID.test(entryId)
      ? await this.entries.findById(tenantId, new Types.ObjectId(entryId))
      : null;
    if (!entry) throw AppError.notFound(`Entry ${entryId} not found`, { entryId });
    const [view] = await this.render([entry]);
    return view;
  }

  /** Did it land? An empty list means nothing was posted under that key or reference —
   * including a request that was attempted but rejected, since those record no idempotency key. */
  async lookup(tenantId: string, lookup: EntryLookup): Promise<EntryList> {
    const entries =
      lookup.by === 'idempotencyKey'
        ? await this.byIdempotencyKey(tenantId, lookup.value)
        : await this.entries.findByReference(tenantId, lookup.value, REFERENCE_OPERATION_TYPES[lookup.by]);
    return { items: await this.render(entries) };
  }

  private async byIdempotencyKey(tenantId: string, key: string): Promise<EntryDoc[]> {
    const record = await this.idempotency.find(tenantId, key);
    const operationId = record ? operationIdOf(record) : null;
    return operationId ? this.entries.findByOperationId(tenantId, operationId) : [];
  }

  /** Loads every entry's postings in one query, keeping each entry's own posting order. */
  private async render(entries: EntryDoc[]): Promise<EntryView[]> {
    const postings = await this.postings.findByIds(entries.flatMap((e) => e.postingIds));
    const byId = new Map(postings.map((p) => [p._id.toHexString(), p]));
    return entries.map((entry) =>
      entryView(
        entry,
        entry.postingIds.map((id) => byId.get(id.toHexString())).filter((p) => p !== undefined)
      )
    );
  }
}

/** Records written before operationId was stamped still carry it inside the stored response. */
function operationIdOf(record: IdempotencyDoc): Types.ObjectId | null {
  if (record.operationId) return record.operationId;
  const fromResult = (record.result as { operationId?: unknown } | null)?.operationId;
  return typeof fromResult === 'string' && OBJECT_ID.test(fromResult) ? new Types.ObjectId(fromResult) : null;
}
