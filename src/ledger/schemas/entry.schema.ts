import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

/** The `entries` collection — a balanced group of postings in a single currency. */
@Schema({ collection: 'entries', versionKey: false })
export class Entry {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: SchemaTypes.ObjectId })
  operationId: Types.ObjectId;

  @Prop({ type: String })
  currency: string;

  @Prop({ type: String })
  operationType: string;

  @Prop({ type: [SchemaTypes.ObjectId], default: [] })
  postingIds: Types.ObjectId[];

  @Prop({ type: String, default: null })
  reference: string | null;

  @Prop({ type: String, default: null })
  actor: string | null;

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  reversalOf: Types.ObjectId | null;

  @Prop({ type: Date })
  createdAt: Date;
}

export const EntrySchema = SchemaFactory.createForClass(Entry);

EntrySchema.index({ operationId: 1 });
EntrySchema.index({ tenantId: 1, reference: 1 });
