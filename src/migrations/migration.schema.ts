import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { CutoverResult } from "./cutover.service";

export type MigrationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MigrationError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

@Schema({ collection: 'migrations', versionKey: false })
export class Migration {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String })
  type: 'cutover';

  @Prop({ type: String })
  ownerId: string;

  /** The request's key; the queued ledger post reuses it, so a redelivered message replays instead of seeding twice. */
  @Prop({ type: String })
  idempotencyKey: string;

  @Prop({ type: String })
  status: MigrationStatus;

  /** Times a consumer has started on it. */
  @Prop({ type: Number, default: 0 })
  attempts: number;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  result: CutoverResult | null;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  error: MigrationError | null;

  @Prop({ type: Date })
  createdAt: Date;

  @Prop({ type: Date })
  updatedAt: Date;

  @Prop({ type: Date, default: null })
  startedAt: Date | null;

  @Prop({ type: Date, default: null })
  finishedAt: Date | null;
}

export type MigrationDoc = Migration;

export const MigrationSchema = SchemaFactory.createForClass(Migration);

MigrationSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
MigrationSchema.index({ tenantId: 1, ownerId: 1, createdAt: -1 });
