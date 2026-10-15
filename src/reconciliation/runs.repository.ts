import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, QueryFilter, Types } from "mongoose";
import { ReconciliationRun, ReconciliationRunDoc } from "./schemas/reconciliation-run.schema";
import { ReconciliationFinding, ReconciliationFindingDoc } from "./schemas/reconciliation-finding.schema";
import { Finding } from "./findings";
import type { RunKind } from "./reconciliation.service";
import { cursorFingerprint, decodeCursor, encodeCursor } from "../common/cursor";

export interface RunListQuery {
  kind?: RunKind;
  ownerId?: string;
  limit: number;
  cursor?: string;
}

@Injectable()
export class RunsRepository implements OnModuleInit {
  constructor(
    @InjectModel(ReconciliationRun.name) private readonly runs: Model<ReconciliationRunDoc>,
    @InjectModel(ReconciliationFinding.name) private readonly findings: Model<ReconciliationFindingDoc>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runs.createCollection().catch(() => undefined);
    await this.findings.createCollection().catch(() => undefined);
    await this.runs.syncIndexes();
    await this.findings.syncIndexes();
  }

  async record(run: ReconciliationRunDoc, findings: Finding[]): Promise<void> {
    await this.runs.create(run);
    if (findings.length === 0) return;
    const createdAt = new Date();
    await this.findings.insertMany(
      findings.map((finding, index) => ({
        _id: new Types.ObjectId(),
        runId: run._id,
        tenantId: finding.tenantId,
        index,
        finding,
        createdAt,
      })),
    );
  }

  /** Newest first. A tenant sees every full run plus its own per-owner runs. */
  async list(tenantId: string, query: RunListQuery): Promise<{ runs: ReconciliationRunDoc[]; nextCursor: string | null }> {
    const fingerprint = cursorFingerprint([tenantId, query.kind ?? null, query.ownerId ?? null]);
    const clauses: QueryFilter<ReconciliationRunDoc>[] = [visibleTo(tenantId)];
    if (query.kind) clauses.push({ kind: query.kind });
    if (query.ownerId) clauses.push({ ownerId: query.ownerId });
    if (query.cursor) {
      const position = decodeCursor(query.cursor, fingerprint);
      if (position.mode === 'time') {
        const id = new Types.ObjectId(position.id);
        clauses.push({
          $or: [{ startedAt: { $lt: position.createdAt } }, { startedAt: position.createdAt, _id: { $lt: id } }],
        });
      }
    }

    const page = await this.runs
      .find({ $and: clauses })
      .sort({ startedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<ReconciliationRunDoc[]>()
      .exec();
    const runs = page.slice(0, query.limit);
    const last = runs.at(-1);
    const nextCursor =
      page.length > query.limit && last
        ? encodeCursor({ mode: 'time', createdAt: last.startedAt, id: last._id.toHexString() }, fingerprint)
        : null;
    return { runs, nextCursor };
  }

  async latestDailyFinishedAt(): Promise<Date | null> {
    const run = await this.runs
      .findOne({ kind: 'daily' })
      .sort({ finishedAt: -1 })
      .lean<ReconciliationRunDoc>()
      .exec();
    return run?.finishedAt ?? null;
  }

  /** The most recent full run: the ledger's current integrity status. */
  latestFullRun(): Promise<ReconciliationRunDoc | null> {
    return this.runs
      .findOne({ kind: { $ne: 'owner' } })
      .sort({ startedAt: -1, _id: -1 })
      .lean<ReconciliationRunDoc>()
      .exec();
  }

  async get(tenantId: string, runId: string): Promise<ReconciliationRunDoc | null> {
    if (!Types.ObjectId.isValid(runId)) return null;
    return this.runs
      .findOne({ $and: [{ _id: new Types.ObjectId(runId) }, visibleTo(tenantId)] })
      .lean<ReconciliationRunDoc>()
      .exec();
  }

  async findingsFor(runId: Types.ObjectId, tenantId: string): Promise<Finding[]> {
    const docs = await this.findings
      .find({ runId, tenantId })
      .sort({ index: 1 })
      .lean<ReconciliationFindingDoc[]>()
      .exec();
    return docs.map((d) => d.finding);
  }
}

function visibleTo(tenantId: string): QueryFilter<ReconciliationRunDoc> {
  return { $or: [{ kind: { $ne: 'owner' } }, { tenantId }] };
}
