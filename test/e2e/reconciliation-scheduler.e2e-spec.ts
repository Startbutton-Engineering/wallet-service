import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import { RecordingNotifier } from "../utils/recording-notifier";
import { FakeClock } from "../utils/fake-clock";
import { LEDGER_ALERT_NOTIFIER } from "../../src/reconciliation/alerts/ledger-alert";
import { CLOCK } from "../../src/common/clock";
import { ReconciliationScheduler } from "../../src/reconciliation/reconciliation.scheduler";
import { CONFIG, loadConfig } from "../../src/config";

// The daily run is due at 02:00 Africa/Lagos (UTC+1, no DST), i.e. 01:00Z.
describe('Reconciliation scheduler', () => {
  let ctx: TestApp;
  let clock: FakeClock;
  let notifier: RecordingNotifier;

  beforeEach(async () => {
    clock = new FakeClock('2026-10-04T01:30:00Z');
    notifier = new RecordingNotifier();
    ctx = await createTestApp([
      { provide: CLOCK, useValue: clock },
      { provide: LEDGER_ALERT_NOTIFIER, useValue: notifier },
    ]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  const tick = (app: TestApp = ctx) => app.app.get(ReconciliationScheduler).tick();

  async function dailyRuns(app: TestApp = ctx): Promise<{ runDate: string; attempt: number }[]> {
    const res = await request(app.app.getHttpServer())
      .get('/reports/reconciliation?kind=daily')
      .set('x-api-key', TEST_API_KEY);
    expect(res.status).toBe(200);
    return res.body.data.runs.map((r: { runDate: string; attempt: number }) => ({ runDate: r.runDate, attempt: r.attempt }));
  }

  it('runs once the daily window has passed, and only once for that day', async () => {
    await tick();
    await tick();

    expect(await dailyRuns()).toEqual([{ runDate: '2026-10-04', attempt: 1 }]);
  });

  it('does not run again before the next day\'s window', async () => {
    await tick();

    clock.set('2026-10-05T00:55:00Z'); // 01:55 Lagos, five minutes early
    await tick();
    expect(await dailyRuns()).toHaveLength(1);

    clock.set('2026-10-05T01:00:00Z'); // 02:00 Lagos
    await tick();
    expect(await dailyRuns()).toEqual([
      { runDate: '2026-10-05', attempt: 1 },
      { runDate: '2026-10-04', attempt: 1 },
    ]);
  });

  it('catches up a missed window as soon as a replica comes up', async () => {
    // The service was down through 2026-10-04's window and only came back at 01:30 Lagos on the 5th.
    clock.set('2026-10-05T00:30:00Z');

    await tick();

    expect(await dailyRuns()).toEqual([{ runDate: '2026-10-04', attempt: 1 }]);
  });

  it('does not count a manual run as the day\'s daily run', async () => {
    await request(ctx.app.getHttpServer()).post('/reconciliation/runs').set('x-api-key', TEST_API_KEY).set('idempotency-key', randomUUID());
    expect(await dailyRuns()).toEqual([]);
  });

  /** A replica that took the lease and started the day's run, then died without finishing. */
  async function givenReplicaDiedMidRun(runDate: string): Promise<void> {
    const now = clock.now();
    await ctx.db.collection('locks').insertOne({
      _id: 'reconciliation' as never, holderId: 'dead-replica', expiresAt: new Date(now.getTime() + 2 * 60 * 1000), createdAt: now,
    });
    await ctx.db.collection('reconciliationDailyClaims').insertOne({
      _id: runDate as never, status: 'running', attempt: 1, runId: null,
      attempts: [{ attempt: 1, holderId: 'dead-replica', startedAt: now, endedAt: null, outcome: null, error: null }],
    });
  }

  it('waits out a dead holder\'s lease, then retries that day as a new attempt', async () => {
    await givenReplicaDiedMidRun('2026-10-04');

    await tick();
    expect(await dailyRuns()).toEqual([]);

    clock.advance(2 * 60 * 1000 + 1);
    await tick();
    expect(await dailyRuns()).toEqual([{ runDate: '2026-10-04', attempt: 2 }]);
  });

  describe('liveness', () => {
    const HOUR = 60 * 60 * 1000;
    const livenessAlerts = () => notifier.sent.filter((a) => a.key === 'recon:liveness').map((a) => a.kind);

    /** A replica that holds the lease and keeps renewing it but never finishes its run. */
    const givenStuckHolder = () =>
      ctx.db.collection('locks').updateOne(
        { _id: 'reconciliation' as never },
        { $set: { holderId: 'stuck-replica', expiresAt: new Date('2030-01-01T00:00:00Z') } },
      );

    it('pages when no daily run has completed for more than 26 hours, even while another replica holds the lease', async () => {
      await tick(); // completes 2026-10-04's run at 01:30Z
      await givenStuckHolder();

      clock.advance(26 * HOUR);
      await tick();
      expect(livenessAlerts()).toEqual([]);

      clock.advance(60 * 1000);
      await tick();
      expect(livenessAlerts()).toEqual(['page']);
    });

    it('does not re-page on every tick while still stalled, and resolves once a run completes', async () => {
      await tick();
      await givenStuckHolder();
      clock.advance(27 * HOUR);
      await tick();

      clock.advance(5 * 60 * 1000);
      await tick();
      expect(livenessAlerts()).toEqual(['page']);

      await ctx.db.collection('locks').updateOne({ _id: 'reconciliation' as never }, { $set: { expiresAt: clock.now() } });
      await tick();
      expect(livenessAlerts()).toEqual(['page', 'resolved']);
    });

    it('stays quiet while runs complete every day', async () => {
      for (let day = 0; day < 3; day++) {
        await tick();
        clock.advance(24 * HOUR);
      }

      expect(notifier.sent).toEqual([]);
      expect(await dailyRuns()).toHaveLength(3);
    });
  });

  describe('when RECONCILIATION_ENABLED is set', () => {
    it('ticks on its own every poll interval', async () => {
      const enabled = await createTestApp([
        { provide: CLOCK, useValue: clock },
        { provide: LEDGER_ALERT_NOTIFIER, useValue: notifier },
        {
          provide: CONFIG,
          useValue: {
            ...loadConfig({ MONGO_PATH: process.env.TEST_MONGO_PATH, API_KEYS: TEST_API_KEY } as NodeJS.ProcessEnv),
            dbName: `ledger_test_${randomUUID().replace(/-/g, '')}`,
            reconciliation: { enabled: true, runAt: '02:00', timeZone: 'Africa/Lagos', pollIntervalMs: 50 },
          },
        },
      ]);
      try {
        let runs: unknown[] = [];
        for (let i = 0; i < 100 && runs.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          runs = await dailyRuns(enabled);
        }
        expect(runs).toEqual([{ runDate: '2026-10-04', attempt: 1 }]);
      } finally {
        // Stop polling before the database is dropped, or a last tick races the teardown.
        await enabled.app.get(ReconciliationScheduler).onApplicationShutdown();
        await enabled.close();
      }
    });

    it('leaves the scheduler idle when the flag is off', async () => {
      await new Promise((r) => setTimeout(r, 200));

      expect(await dailyRuns()).toEqual([]);
    });
  });

  describe('across replicas', () => {
    let replica: TestApp;

    beforeEach(async () => {
      replica = await createTestApp(
        [
          { provide: CLOCK, useValue: clock },
          { provide: LEDGER_ALERT_NOTIFIER, useValue: notifier },
        ],
        { dbName: ctx.db.db.databaseName },
      );
    });

    afterEach(async () => {
      await replica.app.close();
    });

    it('runs the day\'s reconciliation exactly once when two replicas tick together', async () => {
      await Promise.all([tick(ctx), tick(replica)]);
      await Promise.all([tick(ctx), tick(replica)]);

      expect(await dailyRuns()).toEqual([{ runDate: '2026-10-04', attempt: 1 }]);
    });
  });
});
