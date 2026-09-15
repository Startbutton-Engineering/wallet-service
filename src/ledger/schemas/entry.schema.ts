import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

/** The `entries` collection — a balanced group of postings in a single currency. */
@Schema({ collection: 'entries', versionKey: false })
export class Entry {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String })
  operationId: string;

  @Prop({ type: String })
  currency: string;

  @Prop({ type: String })
  operationType: string;

  @Prop({ type: [String], default: [] })
  postingIds: string[];

  @Prop({ type: String, default: null })
  reference: string | null;

  @Prop({ type: String, default: null })
  actor: string | null;

  @Prop({ type: String, default: null })
  reversalOf: string | null;

  @Prop({ type: Date })
  createdAt: Date;
}

export const EntrySchema = SchemaFactory.createForClass(Entry);

EntrySchema.index({ operationId: 1 });
EntrySchema.index({ tenantId: 1, reference: 1 });
