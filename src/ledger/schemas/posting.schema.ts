import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { Direction } from "../types";
import type { AccountKind, WalletType } from "../../accounts/account";

@Schema({ collection: 'postings', versionKey: false })
export class Posting {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: SchemaTypes.ObjectId })
  operationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId })
  entryId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId })
  accountId: Types.ObjectId;

  @Prop({ type: String, default: null })
  ownerId: string | null;

  @Prop({ type: String, default: null })
  walletType: WalletType | null;

  @Prop({ type: String })
  accountType: string;

  @Prop({ type: String })
  kind: AccountKind;

  @Prop({ type: String })
  currency: string;

  @Prop({ type: String })
  direction: Direction;

  @Prop({ type: SchemaTypes.Decimal128 })
  amount: Types.Decimal128;

  @Prop({ type: SchemaTypes.Decimal128, default: null })
  balanceAfter: Types.Decimal128 | null;

  @Prop({ type: Number, default: null })
  sequence: number | null;

  @Prop({ type: String })
  operationType: string;

  @Prop({ type: String, default: null })
  reference: string | null;

  @Prop({ type: String, default: null })
  actor: string | null;

  @Prop({ type: Date })
  createdAt: Date;
}

export const PostingSchema = SchemaFactory.createForClass(Posting);

PostingSchema.index({ accountId: 1, sequence: 1 });
PostingSchema.index({ operationId: 1 });
PostingSchema.index({ tenantId: 1, reference: 1, accountType: 1, currency: 1, operationType: 1 });
