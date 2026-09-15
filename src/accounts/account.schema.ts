import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { AccountKind } from "./account";

/** The `accounts` collection. `_id` is the deterministic id built by
 * userAccountId()/systemAccountId(), never an ObjectId.
 *
 * `version` is the application's own OCC counter (guarded on every user-account
 * update in LedgerService) — not mongoose's `__v`, which is disabled. Timestamps
 * are written explicitly by the repositories inside transactions, so mongoose's
 * `timestamps` option is deliberately left off.
 */
@Schema({ collection: 'accounts', versionKey: false })
export class Account {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ type: String, default: null })
  ownerId: string | null;

  @Prop({ type: String })
  currency: string;

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

AccountSchema.index({ tenantId: 1, ownerId: 1, currency: 1, accountType: 1 });
AccountSchema.index({ tenantId: 1, kind: 1, currency: 1 });
