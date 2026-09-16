import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { AccountKind, WalletType } from "./account";

@Schema({ collection: 'accounts', versionKey: false })
export class Account {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String, default: null })
  ownerId: string | null;

  @Prop({ type: String })
  currency: string;

  @Prop({ type: String, default: null })
  walletType: WalletType | null;

  @Prop({ type: String })
  accountType: string;

  @Prop({ type: String })
  kind: AccountKind;

  @Prop({ type: SchemaTypes.Decimal128 })
  balance: Types.Decimal128;

  @Prop({ type: Number })
  version: number;

  @Prop({ type: Number })
  sequence: number;

  @Prop({ type: Date })
  createdAt: Date;

  @Prop({ type: Date })
  updatedAt: Date;
}

export const AccountSchema = SchemaFactory.createForClass(Account);

AccountSchema.index(
  { tenantId: 1, ownerId: 1, currency: 1, walletType: 1, accountType: 1 },
  { unique: true }
);
AccountSchema.index({ tenantId: 1, kind: 1, currency: 1 });
