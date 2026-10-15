import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { Finding } from "../findings";

/** What one run found wrong, kept forever and never edited after the run. */
@Schema({ collection: 'reconciliationFindings', versionKey: false })
export class ReconciliationFinding {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId })
  runId: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  /** Position within the run, so findings read back in the order the run reported them. */
  @Prop({ type: Number })
  index: number;

  @Prop({ type: SchemaTypes.Mixed })
  finding: Finding;

  @Prop({ type: Date })
  createdAt: Date;
}

export type ReconciliationFindingDoc = ReconciliationFinding;

export const ReconciliationFindingSchema = SchemaFactory.createForClass(ReconciliationFinding);

ReconciliationFindingSchema.index({ runId: 1, tenantId: 1, index: 1 });
