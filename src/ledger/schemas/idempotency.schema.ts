import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";


@Schema({ collection: 'idempotency', versionKey: false, minimize: false })
export class Idempotency {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String })
  key: string;

  @Prop({ type: String })
  requestHash: string;

  @Prop({ type: String })
  operationType: string;

  @Prop({ type: String })
  status: 'completed';

  @Prop({ type: SchemaTypes.Mixed, default: null })
  result: unknown;

  @Prop({ type: Date })
  createdAt: Date;
}

export const IdempotencySchema = SchemaFactory.createForClass(Idempotency);

IdempotencySchema.index({ tenantId: 1, key: 1 }, { unique: true });
