import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { LedgerAlertKind } from "./ledger-alert";

export type AlertStatus = 'open' | 'resolved';

/** One incident: opened by the first failing check, closed by the first passing one. Kept forever. */
@Schema({ collection: 'ledgerAlerts', versionKey: false })
export class LedgerAlertRecord {
  @Prop({ type: SchemaTypes.ObjectId })
  _id: Types.ObjectId;

  @Prop({ type: String })
  key: string;

  @Prop({ type: String })
  status: AlertStatus;

  @Prop({ type: String })
  title: string;

  @Prop({ type: SchemaTypes.Mixed })
  fields: Record<string, string>;

  @Prop({ type: Date })
  openedAt: Date;

  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  /** True once the opening page reached Slack. Until then the page, not a reminder, is retried. */
  @Prop({ type: Boolean })
  paged: boolean;

  /** The notification still owed for this alert; null once delivered. */
  @Prop({ type: String, default: null })
  pending: LedgerAlertKind | null;

  @Prop({ type: Number })
  deliveryAttempts: number;

  @Prop({ type: String, default: null })
  lastDeliveryError: string | null;

  @Prop({ type: Date, default: null })
  lastNotifiedAt: Date | null;
}

export type LedgerAlertDoc = LedgerAlertRecord;

export const LedgerAlertSchema = SchemaFactory.createForClass(LedgerAlertRecord);

// At most one open incident per key; resolved ones accumulate as history.
LedgerAlertSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
LedgerAlertSchema.index({ pending: 1 });
