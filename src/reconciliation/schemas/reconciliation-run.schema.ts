import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { RunKind, RunStatus } from "../reconciliation.service";

export interface TrialBalanceLine {
  tenantId: string;
  currency: string;
  balancesNet: string;
  postingsNet: string;
}

/** One reconciliation run, kept forever for audit. Runs are append-only once finished. */
@Schema({ collection: 'reconciliationRuns', versionKey: false })
export class ReconciliationRun {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  kind: RunKind;

  @Prop({ type: String })
  status: RunStatus;

  /** Set only on per-owner runs; full runs cover every tenant. */
  @Prop({ type: String, default: null })
  tenantId: string | null;

  @Prop({ type: String, default: null })
  ownerId: string | null;

  @Prop({ type: String, default: null })
  currency: string | null;

  /** Daily runs only: the local date whose window this run covers. */
  @Prop({ type: String, default: null })
  runDate: string | null;

  /** Daily runs only: 1, or higher when an earlier attempt for the same date was abandoned. */
  @Prop({ type: Number, default: null })
  attempt: number | null;

  @Prop({ type: Number })
  accountsChecked: number;

  @Prop({ type: Number })
  mismatchCount: number;

  @Prop({ type: [SchemaTypes.Mixed], default: [] })
  trialBalance: TrialBalanceLine[];

  @Prop({ type: Date })
  startedAt: Date;

  @Prop({ type: Date })
  finishedAt: Date;
}

export type ReconciliationRunDoc = ReconciliationRun;

export const ReconciliationRunSchema = SchemaFactory.createForClass(ReconciliationRun);

ReconciliationRunSchema.index({ startedAt: -1, _id: -1 });
ReconciliationRunSchema.index({ kind: 1, startedAt: -1, _id: -1 });
ReconciliationRunSchema.index({ tenantId: 1, ownerId: 1, startedAt: -1 });
ReconciliationRunSchema.index({ runDate: 1 }, { partialFilterExpression: { kind: 'daily' } });
