import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes } from "mongoose";

@Schema({ collection: 'outbox', versionKey: false, minimize: false })
export class Outbox {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String })
  type: string;

  @Prop({ type: Number })
  schemaVersion: number;

  @Prop({ type: String })
  dedupeId: string;

  @Prop({ type: String })
  operationId: string;

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
