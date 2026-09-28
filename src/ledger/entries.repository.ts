import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Entry } from "./schemas/entry.schema";
import { EntryDoc } from "./types";

@Injectable()
export class EntriesRepository {
  constructor(@InjectModel(Entry.name) private readonly model: Model<EntryDoc>) {}

  async findUnresolvedInitiations(
    tenantId: string,
    initiateOperationType: string,
    resolvingOperationTypes: string[],
    opts: { limit?: number } = {},
  ): Promise<EntryDoc[]> {
    const initiated = await this.model
      .find({ tenantId, operationType: initiateOperationType })
      .sort({ createdAt: -1 })
      .lean<EntryDoc[]>()
      .exec();

    if (initiated.length === 0) return [];

    const references = [
      ...new Set(initiated.map((e) => e.reference).filter((r): r is string => !!r)),
    ];

    const resolved = await this.model
      .find({ tenantId, operationType: { $in: resolvingOperationTypes }, reference: { $in: references } })
      .lean<EntryDoc[]>()
      .exec();
    const resolvedRefs = new Set(resolved.map((e) => e.reference));

    const seen = new Set<string>();
    const unresolved: EntryDoc[] = [];
    for (const entry of initiated) {
      if (!entry.reference || resolvedRefs.has(entry.reference) || seen.has(entry.reference)) continue;
      seen.add(entry.reference);
      unresolved.push(entry);
    }
    return unresolved.slice(0, opts.limit ?? 50);
  }
}
