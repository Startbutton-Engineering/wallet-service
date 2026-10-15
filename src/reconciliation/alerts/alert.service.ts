import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, mongo, QueryFilter, Types } from "mongoose";
import { CLOCK } from "../../common/clock";
import type { Clock } from "../../common/clock";
import { LEDGER_ALERT_NOTIFIER } from "./ledger-alert";
import type { LedgerAlertNotifier } from "./ledger-alert";
import { LedgerAlertDoc, LedgerAlertRecord } from "./ledger-alert.schema";

export interface Firing {
  key: string;
  title: string;
  fields: Record<string, string>;
  remindEveryMs?: number;
}

/** Which alert keys a check evaluated: only those can be resolved by it passing. */
export type AlertScope = { prefixes: string[] } | { keys: string[] };

@Injectable()
export class AlertService implements OnModuleInit {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    @InjectModel(LedgerAlertRecord.name) private readonly alerts: Model<LedgerAlertDoc>,
    @Inject(LEDGER_ALERT_NOTIFIER) private readonly notifier: LedgerAlertNotifier,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.alerts.createCollection().catch(() => undefined);
    await this.alerts.syncIndexes();
  }

  async sync(scope: AlertScope, firing: Firing[]): Promise<void> {
    const now = this.clock.now();
    const firingKeys = new Set(firing.map((f) => f.key));

    for (const f of firing) {
      const open = await this.alerts.findOne({ key: f.key, status: 'open' }).lean<LedgerAlertDoc>().exec();
      if (!open) {
        await this.open(f, now);
      } else {
        // An undelivered page is still owed; otherwise remind with the latest figures.
        const remindDue =
          !f.remindEveryMs || !open.lastNotifiedAt || now.getTime() - open.lastNotifiedAt.getTime() >= f.remindEveryMs;
        const pending = !open.paged ? 'page' : remindDue ? 'reminder' : open.pending;
        await this.alerts.updateOne({ _id: open._id }, { $set: { fields: f.fields, pending } });
      }
    }

    const stale = await this.alerts
      .find({ $and: [scopeFilter(scope), { status: 'open', key: { $nin: [...firingKeys] } }] })
      .lean<LedgerAlertDoc[]>()
      .exec();
    for (const alert of stale) {
      // Nobody was paged for an alert whose page never got through, so there is nothing to resolve.
      await this.alerts.updateOne(
        { _id: alert._id },
        { $set: { status: 'resolved', resolvedAt: now, pending: alert.paged ? 'resolved' : null } },
      );
    }

    await this.deliverPending();
  }

  private async open(f: Firing, now: Date): Promise<void> {
    try {
      await this.alerts.create({
        _id: new Types.ObjectId(),
        key: f.key,
        status: 'open',
        title: f.title,
        fields: f.fields,
        openedAt: now,
        resolvedAt: null,
        paged: false,
        pending: 'page',
        deliveryAttempts: 0,
        lastDeliveryError: null,
        lastNotifiedAt: null,
      });
    } catch (err) {
      // Another replica opened the same alert a moment earlier; its page covers this one.
      if (err instanceof mongo.MongoServerError && err.code === 11000) return;
      throw err;
    }
  }

  private async deliverPending(): Promise<void> {
    // Oldest incident first, so alerts reach Slack in the order the checks raised them.
    const owed = await this.alerts
      .find({ pending: { $ne: null } })
      .sort({ openedAt: 1, _id: 1 })
      .lean<LedgerAlertDoc[]>()
      .exec();
    for (const alert of owed) {
      const kind = alert.pending!;
      try {
        await this.notifier.send({ kind, key: alert.key, title: alert.title, fields: alert.fields });
        await this.alerts.updateOne(
          { _id: alert._id },
          {
            $set: { pending: null, lastNotifiedAt: this.clock.now(), lastDeliveryError: null, ...(kind === 'page' ? { paged: true } : {}) },
            $inc: { deliveryAttempts: 1 },
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Ledger alert ${alert.key} (${kind}) was not delivered: ${message}`);
        await this.alerts.updateOne(
          { _id: alert._id },
          { $set: { lastDeliveryError: message }, $inc: { deliveryAttempts: 1 } },
        );
      }
    }
  }
}

function scopeFilter(scope: AlertScope): QueryFilter<LedgerAlertDoc> {
  return 'prefixes' in scope
    ? { $or: scope.prefixes.map((p) => ({ key: { $regex: `^${escapeRegex(p)}` } })) }
    : { key: { $in: scope.keys } };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
