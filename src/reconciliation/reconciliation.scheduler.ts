import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { hostname } from "os";
import { randomUUID } from "crypto";
import { CLOCK } from "../common/clock";
import type { Clock } from "../common/clock";
import { CONFIG } from "../config";
import type { AppConfig } from "../config";
import { ReconciliationService } from "./reconciliation.service";
import { dueRunDate } from "./schedule";
import { LeaseRepository } from "./lease.repository";
import { DailyClaimsRepository } from "./daily-claims.repository";
import { AlertService } from "./alerts/alert.service";
import { RunsRepository } from "./runs.repository";

export const LEASE_NAME = 'reconciliation';
export const LEASE_TTL_MS = 2 * 60 * 1000;
const LEASE_RENEW_MS = 30 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const LIVENESS_THRESHOLD_MS = 26 * HOUR_MS;
export const LIVENESS_ALERT_KEY = 'recon:liveness';

@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  readonly holderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly reconciliation: ReconciliationService,
    private readonly lease: LeaseRepository,
    private readonly claims: DailyClaimsRepository,
    private readonly runs: RunsRepository,
    private readonly alerts: AlertService,
  ) {}

  onApplicationBootstrap(): void {
    const { enabled, pollIntervalMs } = this.config.reconciliation;
    if (!enabled) return;
    this.logger.log(`Reconciliation scheduler started as ${this.holderId}`);
    const poll = () => {
      if (this.inFlight) return;
      this.inFlight = this.tick()
        .catch((err) => this.logger.error(`Reconciliation tick failed: ${err instanceof Error ? err.stack : err}`))
        .finally(() => {
          this.inFlight = null;
        });
    };
    this.timer = setInterval(poll, pollIntervalMs);
    poll();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async tick(): Promise<void> {
    await this.runIfDue();
    await this.checkLiveness();
  }

  private async runIfDue(): Promise<void> {
    const { runAt, timeZone } = this.config.reconciliation;
    const runDate = dueRunDate(this.clock.now(), runAt, timeZone);
    const hasCompleted = await this.claims.isCompleted(runDate);
    if (hasCompleted) return;
    if (!(await this.lease.tryAcquire(LEASE_NAME, this.holderId, this.clock.now(), LEASE_TTL_MS))) return;

    const renewal = setInterval(() => {
      this.lease.renew(LEASE_NAME, this.holderId, this.clock.now(), LEASE_TTL_MS).catch((err) => {
        this.logger.error(`Could not renew the reconciliation lease: ${err}`);
      });
    }, LEASE_RENEW_MS);
    try {
      const attempt = await this.claims.begin(runDate, this.holderId, this.clock.now());
      if (attempt === null) return;
      try {
        const { run } = await this.reconciliation.trigger('daily', { runDate, attempt });
        await this.claims.complete(runDate, attempt, run._id, this.clock.now());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Daily reconciliation for ${runDate} (attempt ${attempt}) failed: ${message}`);
        await this.claims.fail(runDate, attempt, message, this.clock.now());
      }
    } finally {
      clearInterval(renewal);
      await this.lease.release(LEASE_NAME, this.holderId, this.clock.now());
    }
  }

  private async checkLiveness(): Promise<void> {
    const since = (await this.runs.latestDailyFinishedAt()) ?? (await this.lease.firstAcquiredAt(LEASE_NAME));
    if (!since) return;
    const now = this.clock.now();
    const stalled = now.getTime() - since.getTime() > LIVENESS_THRESHOLD_MS;
    await this.alerts.sync(
      { keys: [LIVENESS_ALERT_KEY] },
      stalled
        ? [
            {
              key: LIVENESS_ALERT_KEY,
              title: 'Daily ledger reconciliation has not run',
              fields: {
                'Last completed run': since.toISOString(),
                'Hours since': String(Math.floor((now.getTime() - since.getTime()) / HOUR_MS)),
              },
              remindEveryMs: 24 * HOUR_MS,
            },
          ]
        : [],
    );
  }
}
