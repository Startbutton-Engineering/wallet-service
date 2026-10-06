import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import { RecordingNotifier } from "../utils/recording-notifier";
import { LEDGER_ALERT_NOTIFIER } from "../../src/reconciliation/alerts/ledger-alert";

describe('Reports', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp([{ provide: LEDGER_ALERT_NOTIFIER, useValue: new RecordingNotifier() }]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  function post(path: string, body: Record<string, unknown>, tenantId?: string) {
    const req = request(ctx.app.getHttpServer())
      .post(path)
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', randomUUID());
    if (tenantId) req.set('x-tenant-id', tenantId);
    return req.send(body);
  }

  function get(path: string, tenantId?: string) {
    const req = request(ctx.app.getHttpServer()).get(path).set('x-api-key', TEST_API_KEY);
    if (tenantId) req.set('x-tenant-id', tenantId);
    return req;
  }

  async function givenSettledCollection(amount: string, currency = 'NGN', tenantId?: string): Promise<string> {
    const ownerId = randomUUID();
    const collectionId = randomUUID();
    await post('/collections/collect', { collectionId, ownerId, currency, amount }, tenantId);
    const res = await post('/collections/settle', { collectionId, ownerId, currency, amount }, tenantId);
    expect(res.status).toBe(201);
    return ownerId;
  }

  /** 500000 NGN collected and settled, then 150000 NGN converted to 100 USD at 1500 and approved. */
  async function givenApprovedConversion(): Promise<string> {
    const ownerId = await givenSettledCollection('500000');
    const conversion = { conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD' };
    expect((await post('/conversions/initiate', { ...conversion, fromAmount: '150000', rate: '1500' })).status).toBe(201);
    expect((await post('/conversions/approve', conversion)).status).toBe(201);
    return ownerId;
  }

  describe('GET /reports/trial-balance', () => {
    it('lists every currency\'s system accounts and aggregated user accounts, netting to zero', async () => {
      await givenApprovedConversion();

      const res = await get('/reports/trial-balance');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        balanced: true,
        currencies: [
          {
            currency: 'NGN',
            totalDebits: '500000',
            totalCredits: '500000',
            net: '0',
            balanced: true,
            systemAccounts: [
              { name: 'external:collection', balance: '-500000' },
              { name: 'fx:NGN', balance: '150000' },
            ],
            userAccounts: [
              { walletType: 'collection', accountType: 'available', accountCount: 1, balance: '350000' },
              { walletType: 'collection', accountType: 'held-inflow', accountCount: 1, balance: '0' },
              { walletType: 'collection', accountType: 'held-outflow', accountCount: 1, balance: '0' },
              { walletType: 'collection', accountType: 'refund-chargeback', accountCount: 1, balance: '0' },
            ],
          },
          {
            currency: 'USD',
            totalDebits: '100',
            totalCredits: '100',
            net: '0',
            balanced: true,
            systemAccounts: [{ name: 'fx:USD', balance: '-100' }],
            userAccounts: [
              { walletType: 'collection', accountType: 'available', accountCount: 1, balance: '100' },
              { walletType: 'collection', accountType: 'held-inflow', accountCount: 1, balance: '0' },
              { walletType: 'collection', accountType: 'held-outflow', accountCount: 1, balance: '0' },
              { walletType: 'collection', accountType: 'refund-chargeback', accountCount: 1, balance: '0' },
            ],
          },
        ],
      });
    });

    it('aggregates many owners into one row per wallet and account type', async () => {
      await givenSettledCollection('1000');
      await givenSettledCollection('2500');

      const res = await get('/reports/trial-balance');

      const [ngn] = res.body.data.currencies;
      expect(ngn.userAccounts[0]).toEqual({
        walletType: 'collection', accountType: 'available', accountCount: 2, balance: '3500',
      });
    });

    it('flags a currency whose balances do not net to zero', async () => {
      const ownerId = await givenSettledCollection('1000');
      await ctx.db.collection('accounts').updateOne(
        { ownerId, accountType: 'available' },
        { $set: { balance: (await import('mongoose')).Types.Decimal128.fromString('1003') } },
      );

      const res = await get('/reports/trial-balance');

      expect(res.body.data.balanced).toBe(false);
      expect(res.body.data.currencies[0]).toMatchObject({
        totalDebits: '1000', totalCredits: '1003', net: '3', balanced: false,
      });
    });

    it('only shows the calling tenant\'s ledger', async () => {
      await givenSettledCollection('1000');
      await givenSettledCollection('777', 'NGN', 'tenant-b');

      const res = await get('/reports/trial-balance', 'tenant-b');

      expect(res.body.data.currencies[0].systemAccounts).toEqual([{ name: 'external:collection', balance: '-777' }]);
    });
  });

  describe('GET /reports/system-positions', () => {
    it('lists system account balances per currency, with FX positions grouped separately', async () => {
      await givenApprovedConversion();

      const res = await get('/reports/system-positions');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        currencies: [
          { currency: 'NGN', accounts: [{ name: 'external:collection', balance: '-500000' }] },
          { currency: 'USD', accounts: [] },
        ],
        // Raw per currency: there is no authoritative rate to value them in a base currency.
        fxPositions: [
          { currency: 'NGN', account: 'fx:NGN', balance: '150000' },
          { currency: 'USD', account: 'fx:USD', balance: '-100' },
        ],
      });
    });

    it('only shows the calling tenant\'s positions', async () => {
      await givenSettledCollection('1000');

      const res = await get('/reports/system-positions', 'tenant-b');

      expect(res.body.data).toEqual({ currencies: [], fxPositions: [] });
    });
  });

  describe('reconciliation history', () => {
    const runAll = (tenantId?: string) => post('/reconciliation/runs', {}, tenantId);
    const runOwner = (ownerId: string, tenantId?: string) => post(`/reconciliation/owners/${ownerId}`, {}, tenantId);

    async function corrupt(ownerId: string, balance: string) {
      const { Types } = await import('mongoose');
      await ctx.db.collection('accounts').updateOne(
        { ownerId, accountType: 'available' },
        { $set: { balance: Types.Decimal128.fromString(balance) } },
      );
    }

    it('lists runs newest first, including only the caller\'s own per-owner runs', async () => {
      const ownerA = await givenSettledCollection('1000');
      const ownerB = await givenSettledCollection('1000', 'NGN', 'tenant-b');
      const first = await runAll();
      const ownRun = await runOwner(ownerA);
      await runOwner(ownerB, 'tenant-b');
      const last = await runAll();

      const res = await get('/reports/reconciliation');

      expect(res.status).toBe(200);
      expect(res.body.data.runs.map((r: { runId: string }) => r.runId)).toEqual([
        last.body.data.runId, ownRun.body.data.runId, first.body.data.runId,
      ]);
      expect(res.body.data.latest).toMatchObject({ runId: last.body.data.runId, kind: 'manual', status: 'ok' });
      expect(res.body.data.runs[1]).toMatchObject({ kind: 'owner', ownerId: ownerA, accountsChecked: 4 });
      expect(res.body.data.nextCursor).toBeNull();
    });

    it('filters by kind and pages with a cursor', async () => {
      await givenSettledCollection('1000');
      const first = await runAll();
      const second = await runAll();
      await runOwner(randomUUID());

      const page1 = await get('/reports/reconciliation?kind=manual&limit=1');
      const page2 = await get(`/reports/reconciliation?kind=manual&limit=1&cursor=${page1.body.data.nextCursor}`);

      expect(page1.body.data.runs.map((r: { runId: string }) => r.runId)).toEqual([second.body.data.runId]);
      expect(page2.body.data.runs.map((r: { runId: string }) => r.runId)).toEqual([first.body.data.runId]);
      expect(page2.body.data.nextCursor).toBeNull();
    });

    it('shows a run\'s findings and trial balance for the calling tenant only', async () => {
      const ownerA = await givenSettledCollection('1000');
      const ownerB = await givenSettledCollection('2000', 'NGN', 'tenant-b');
      await corrupt(ownerA, '1001');
      await corrupt(ownerB, '2002');
      const run = await runAll();
      const { runId } = run.body.data;

      const asA = await get(`/reports/reconciliation/${runId}`);
      const asB = await get(`/reports/reconciliation/${runId}`, 'tenant-b');

      expect(asA.body.data.run).toMatchObject({ runId, status: 'mismatch' });
      expect(asA.body.data.run.trialBalance).toEqual([{ tenantId: '', currency: 'NGN', balancesNet: '1', postingsNet: '0' }]);
      expect(asA.body.data.findings).toEqual([
        expect.objectContaining({ type: 'balance-mismatch', ownerId: ownerA, difference: '1' }),
        expect.objectContaining({ type: 'trial-balance', source: 'balances', net: '1' }),
      ]);
      expect(asB.body.data.findings).toEqual([
        expect.objectContaining({ type: 'balance-mismatch', ownerId: ownerB, difference: '2' }),
        expect.objectContaining({ type: 'trial-balance', source: 'balances', net: '2' }),
      ]);
      // The run response itself is tenant-filtered in the same way.
      expect(run.body.data.findings.map((f: { tenantId: string }) => f.tenantId)).toEqual(['', '']);
    });

    it('returns 404 for an unknown run or another tenant\'s per-owner run', async () => {
      const ownerB = await givenSettledCollection('1000', 'NGN', 'tenant-b');
      const otherTenantRun = await runOwner(ownerB, 'tenant-b');

      expect((await get(`/reports/reconciliation/${'0'.repeat(24)}`)).status).toBe(404);
      expect((await get('/reports/reconciliation/not-an-id')).status).toBe(404);
      expect((await get(`/reports/reconciliation/${otherTenantRun.body.data.runId}`)).status).toBe(404);
    });
  });
});
