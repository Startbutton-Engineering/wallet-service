import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

@Schema({ collection: 'outbox', versionKey: false, minimize: false })
export class Outbox {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String })
  type: string;

  @Prop({ type: Number })
  schemaVersion: number;

  @Prop({ type: String })
  dedupeId: string;

  @Prop({ type: SchemaTypes.ObjectId })
  operationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  payload: Record<string, unknown>;

  @Prop({ type: Boolean })
  published: boolean;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ type: Date })
  createdAt: Date;
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);

OutboxSchema.index({ published: 1, createdAt: 1 });
OutboxSchema.index({ dedupeId: 1 }, { unique: true });
