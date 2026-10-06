import { randomUUID } from "crypto";
import request from 'supertest';
import { Types } from "mongoose";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import { RecordingNotifier } from "../utils/recording-notifier";
import { LEDGER_ALERT_NOTIFIER } from "../../src/reconciliation/alerts/ledger-alert";
import { loadConfig } from "../../src/config";

describe('Reconciliation', () => {
  let ctx: TestApp;
  const notifier = new RecordingNotifier();
  const tenantId = loadConfig().defaultTenantId;

  beforeEach(async () => {
    notifier.reset();
    ctx = await createTestApp([{ provide: LEDGER_ALERT_NOTIFIER, useValue: notifier }]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  function post(path: string, body: Record<string, unknown> = {}, idempotencyKey: string = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post(path)
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  const runReconciliation = () =>
    request(ctx.app.getHttpServer()).post('/reconciliation/runs').set('x-api-key', TEST_API_KEY).send();

  async function givenCollection(amount: string): Promise<string> {
    const ownerId = randomUUID();
    const res = await post('/collections/collect', { collectionId: randomUUID(), ownerId, currency: 'NGN', amount });
    expect(res.status).toBe(201);
    return ownerId;
  }

  /** Drift the materialized balance behind post()'s back, the way a bad manual DB edit would. */
  async function corruptBalance(ownerId: string, accountType: string, balance: string): Promise<string> {
    const account = await ctx.db.collection('accounts').findOneAndUpdate(
      { tenantId, ownerId, currency: 'NGN', walletType: 'collection', accountType },
      { $set: { balance: Types.Decimal128.fromString(balance) } },
    );
    return account!._id.toHexString();
  }

  /** Smuggle an extra credit into an existing entry, breaking double entry behind post()'s back. */
  async function injectStrayPosting(ownerId: string, amount: string): Promise<string> {
    const postings = ctx.db.collection('postings');
    const original = await postings.findOne({ tenantId, ownerId, accountType: 'held-inflow' });
    await postings.insertOne({
      ...original!,
      _id: new Types.ObjectId(),
      direction: 'credit',
      amount: Types.Decimal128.fromString(amount),
    });
    return original!.entryId.toHexString();
  }

  const reconcileOwner = (ownerId: string, query = '') =>
    request(ctx.app.getHttpServer())
      .post(`/reconciliation/owners/${ownerId}${query}`)
      .set('x-api-key', TEST_API_KEY)
      .send();

  const sentFor =(key: string) => notifier.sent.filter((a) => a.key === key).map((a) => a.kind);

  it('reports ok when every materialized balance matches its postings', async () => {
    await givenCollection('25000');

    const res = await runReconciliation();

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'manual', status: 'ok', mismatchCount: 0, findings: [] });
    // One collection wallet (4 sub-accounts) plus external:collection.
    expect(res.body.data.accountsChecked).toBe(5);
    expect(res.body.data.trialBalance).toEqual([
      { tenantId, currency: 'NGN', balancesNet: '0', postingsNet: '0' },
    ]);
    expect(notifier.sent).toEqual([]);
  });

  it('reports a balance that drifted from its postings, with the exact difference, and pages once', async () => {
    const ownerId = await givenCollection('25000');
    const accountId = await corruptBalance(ownerId, 'held-inflow', '25001');

    const res = await runReconciliation();

    expect(res.body.data).toMatchObject({ status: 'mismatch', mismatchCount: 1 });
    expect(res.body.data.findings).toEqual([
      expect.objectContaining({
        type: 'balance-mismatch',
        tenantId,
        accountId,
        ownerId,
        currency: 'NGN',
        walletType: 'collection',
        accountType: 'held-inflow',
        expected: '25000',
        actual: '25001',
        difference: '1',
        postingCount: 1,
      }),
      // The drift also shows up system-wide: materialized balances no longer net to zero.
      { type: 'trial-balance', source: 'balances', tenantId, currency: 'NGN', net: '1' },
    ]);
    expect(notifier.sent.map((a) => [a.kind, a.key])).toEqual([
      ['page', `recon:mismatch:${tenantId}:${accountId}`],
      ['page', `trial-balance:balances:${tenantId}:NGN`],
    ]);
  });

  it('sends a reminder rather than a new page while the mismatch stays open', async () => {
    const ownerId = await givenCollection('25000');
    const accountId = await corruptBalance(ownerId, 'held-inflow', '25001');

    await runReconciliation();
    await runReconciliation();

    expect(sentFor(`recon:mismatch:${tenantId}:${accountId}`)).toEqual(['page', 'reminder']);
  });

  it('sends a resolved alert once the balance matches its postings again', async () => {
    const ownerId = await givenCollection('25000');
    const accountId = await corruptBalance(ownerId, 'held-inflow', '25001');
    await runReconciliation();

    await corruptBalance(ownerId, 'held-inflow', '25000');
    const res = await runReconciliation();
    await runReconciliation();

    expect(res.body.data.status).toBe('ok');
    expect(sentFor(`recon:mismatch:${tenantId}:${accountId}`)).toEqual(['page', 'resolved']);
    expect(sentFor(`trial-balance:balances:${tenantId}:NGN`)).toEqual(['page', 'resolved']);
  });

  it('retries an undelivered page on the next run instead of dropping it', async () => {
    const ownerId = await givenCollection('25000');
    const accountId = await corruptBalance(ownerId, 'held-inflow', '25001');
    notifier.failNext(2);

    const first = await runReconciliation();
    await runReconciliation();

    // Detection is not lost because Slack was down: the run still records the mismatch.
    expect(first.body.data.status).toBe('mismatch');
    expect(sentFor(`recon:mismatch:${tenantId}:${accountId}`)).toEqual(['page']);
    expect(sentFor(`trial-balance:balances:${tenantId}:NGN`)).toEqual(['page']);
  });

  it('detects an unbalanced entry and a non-zero trial balance from postings, and pages for each', async () => {
    const ownerId = await givenCollection('25000');
    const entryId = await injectStrayPosting(ownerId, '7');

    const res = await runReconciliation();

    expect(res.body.data.status).toBe('mismatch');
    expect(res.body.data.trialBalance).toEqual([
      { tenantId, currency: 'NGN', balancesNet: '0', postingsNet: '7' },
    ]);
    expect(res.body.data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'balance-mismatch', ownerId, expected: '25007', actual: '25000', difference: '-7' }),
        { type: 'trial-balance', source: 'postings', tenantId, currency: 'NGN', net: '7' },
        { type: 'unbalanced-entry', tenantId, entryId, currency: 'NGN', net: '7' },
      ]),
    );
    expect(res.body.data.findings).toHaveLength(3);
    expect(sentFor(`trial-balance:postings:${tenantId}:NGN`)).toEqual(['page']);
    expect(sentFor(`unbalanced-entry:${tenantId}:${entryId}`)).toEqual(['page']);
  });

  describe('for one owner', () => {
    it('checks only that owner\'s accounts and reports a drift without a trial balance', async () => {
      const ownerId = await givenCollection('25000');
      await givenCollection('9000');
      const accountId = await corruptBalance(ownerId, 'held-inflow', '24000');

      const res = await reconcileOwner(ownerId);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ kind: 'owner', ownerId, status: 'mismatch', accountsChecked: 4, mismatchCount: 1 });
      // One owner's accounts never net to zero on their own; only the full run proves the trial balance.
      expect(res.body.data).not.toHaveProperty('trialBalance');
      expect(res.body.data.findings).toEqual([
        expect.objectContaining({ type: 'balance-mismatch', accountId, expected: '25000', actual: '24000', difference: '-1000' }),
      ]);
      expect(sentFor(`recon:mismatch:${tenantId}:${accountId}`)).toEqual(['page']);
    });

    it('shares the alert with the full run, so the same drift is never paged twice', async () => {
      const ownerId = await givenCollection('25000');
      const accountId = await corruptBalance(ownerId, 'held-inflow', '24000');

      await reconcileOwner(ownerId);
      await runReconciliation();

      expect(sentFor(`recon:mismatch:${tenantId}:${accountId}`)).toEqual(['page', 'reminder']);
    });

    it('resolves only its own owner\'s alerts when it passes', async () => {
      const brokenOwner = await givenCollection('25000');
      const brokenAccount = await corruptBalance(brokenOwner, 'held-inflow', '24000');
      const healedOwner = await givenCollection('9000');
      const healedAccount = await corruptBalance(healedOwner, 'held-inflow', '9001');
      await runReconciliation();

      await corruptBalance(healedOwner, 'held-inflow', '9000');
      const res = await reconcileOwner(healedOwner);

      expect(res.body.data.status).toBe('ok');
      expect(sentFor(`recon:mismatch:${tenantId}:${healedAccount}`)).toEqual(['page', 'resolved']);
      expect(sentFor(`recon:mismatch:${tenantId}:${brokenAccount}`)).toEqual(['page']);
    });

    it('can be narrowed to one currency', async () => {
      const ownerId = await givenCollection('25000');

      const ngn = await reconcileOwner(ownerId, '?currency=NGN');
      const usd = await reconcileOwner(ownerId, '?currency=USD');

      expect(ngn.body.data).toMatchObject({ currency: 'NGN', accountsChecked: 4, status: 'ok' });
      expect(usd.body.data).toMatchObject({ currency: 'USD', accountsChecked: 0, status: 'ok' });
    });
  });
});
