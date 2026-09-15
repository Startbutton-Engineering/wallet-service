import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes } from "mongoose";


@Schema({ collection: 'idempotency', versionKey: false, minimize: false })
export class Idempotency {
  @Prop({ type: String })
  _id: string;

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
