import { randomUUID } from "crypto";
import request from 'supertest';
import { Types } from "mongoose";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Ledger cutover and legacy effects', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  function post(path: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post(path)
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  const wallets = () => ctx.legacyDb.collection('wallets');

  /** A merchant as back-end has it: two NGN collection partitions, an NGN payout wallet, a USDT wallet. */
  async function givenLegacyMerchant() {
    const merchantId = new Types.ObjectId();
    const ownerId = merchantId.toHexString();
    const doc = (type: string, currency: string, createdAt: string, fields: Record<string, number>) => ({
      _id: new Types.ObjectId(), merchantId, type, currency, createdAt: new Date(createdAt),
      availableBalance: 0, ledgerBalance: 0, lienBalance: 0, refundsOrChargeBackBalance: 0, rollingReserveOverdraftBalance: 0,
      ...fields,
    });
    const canonical = doc('collection', 'NGN', '2025-01-01', { availableBalance: 5000.25, ledgerBalance: 6200, lienBalance: 500 });
    const partition = doc('collection', 'NGN', '2025-06-01', { availableBalance: 100, ledgerBalance: 100 });
    const payout = doc('payout', 'NGN', '2025-01-01', { availableBalance: 2000, ledgerBalance: 2350, refundsOrChargeBackBalance: -3, rollingReserveOverdraftBalance: -2 });
    const usdt = doc('collection', 'USDT', '2025-01-01', { availableBalance: 0.1 + 0.2, ledgerBalance: 0.1 + 0.2 });
    await wallets().insertMany([canonical, partition, payout, usdt]);
    return { ownerId, canonical, partition, payout, usdt };
  }

  const legacyDoc = (id: Types.ObjectId) => wallets().findOne({ _id: id });

  describe('POST /migrations/cutover', () => {
    it('previews the seed without writing anything', async () => {
      const { ownerId, canonical } = await givenLegacyMerchant();

      const res = await post('/migrations/cutover/preview', { ownerId });

      expect(res.status).toBe(201);
      expect(res.body.data.alreadyCutOver).toBe(false);
      expect(res.body.data.wallets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          walletType: 'collection', currency: 'NGN',
          accounts: { available: '460025', lien: '50000', 'legacy-pending': '119975', 'refund-chargeback': '0', 'reserve-overdraft': '0' },
        }),
      ]));
      expect((await legacyDoc(canonical._id))?.ledgerCutover).toBeUndefined();
    });

    it('moves every wallet as it is, merges partitions and marks the legacy documents', async () => {
      const { ownerId, canonical, partition, payout, usdt } = await givenLegacyMerchant();

      const res = await post('/migrations/cutover', { ownerId });

      expect(res.status).toBe(201);
      // The canonical document now carries every partition; the other is zeroed and points at it.
      expect(await legacyDoc(canonical._id)).toMatchObject({
        availableBalance: 5100.25, ledgerBalance: 6300, lienBalance: 500, ledgerCutover: expect.objectContaining({ operationId: res.body.data.operationId }),
      });
      expect(await legacyDoc(partition._id)).toMatchObject({
        availableBalance: 0, ledgerBalance: 0, ledgerCutover: expect.objectContaining({ mergedInto: canonical._id }),
      });
      // Negative fields move as they are.
      expect(await legacyDoc(payout._id)).toMatchObject({
        availableBalance: 2000, ledgerBalance: 2350, refundsOrChargeBackBalance: -3, rollingReserveOverdraftBalance: -2,
      });
      // USDT is converted at wallet-service's scale (10), and float noise is gone.
      expect(await legacyDoc(usdt._id)).toMatchObject({ availableBalance: 0.3, ledgerBalance: 0.3 });
    });

    it('replays the same request and refuses a second cutover', async () => {
      const { ownerId } = await givenLegacyMerchant();
      const key = randomUUID();

      const first = await post('/migrations/cutover', { ownerId }, key);
      const replay = await post('/migrations/cutover', { ownerId }, key);
      const again = await post('/migrations/cutover', { ownerId });

      expect(replay.body.data.operationId).toBe(first.body.data.operationId);
      expect(again.status).toBe(409);
      expect(again.body.data.code).toBe('ALREADY_CUT_OVER');
    });

    it('refuses an owner who already has ledger balances, so nothing is seeded twice', async () => {
      const { ownerId } = await givenLegacyMerchant();
      await post('/topups/credit', { topupId: randomUUID(), ownerId, currency: 'NGN', amount: '100' });

      const res = await post('/migrations/cutover', { ownerId });

      expect(res.status).toBe(409);
      expect(res.body.data.code).toBe('ALREADY_CUT_OVER');
    });

    it('rejects an owner with no legacy wallets', async () => {
      const res = await post('/migrations/cutover', { ownerId: new Types.ObjectId().toHexString() });
      expect(res.status).toBe(404);
    });
  });

  describe('after cutover: native endpoints, transactions created before it applied as legacy would', () => {
    const before = new Date('2025-01-01');
    /** back-end's record of a transaction, created before the merchant's cutover unless told otherwise. */
    const givenTransaction = (transactionReference: string, fields: Record<string, unknown> = {}) =>
      ctx.legacyDb.collection('transactions').insertOne({ transactionReference, createdAt: before, ...fields });
    const cutOverMerchant = async () => {
      const merchant = await givenLegacyMerchant();
      await post('/migrations/cutover', { ownerId: merchant.ownerId });
      return merchant;
    };
    const payoutStatus = (ownerId: string, payoutId: string, status: string, amount = '40000') =>
      post('/payouts/status', { payoutId, ownerId, currency: 'NGN', amount, status });

    it('settles a pre-cutover payout success against legacy-pending', async () => {
      const { ownerId, payout } = await cutOverMerchant();
      await givenTransaction('TRF-OLD-1');

      const res = await payoutStatus(ownerId, 'TRF-OLD-1', 'success');

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ payoutId: 'TRF-OLD-1', status: 'success', balance: { legacyPending: '-5000' } });
      // legacy-pending was 350; the 400 payout leaves the -50 historical gap in plain view.
      expect(await legacyDoc(payout._id)).toMatchObject({ availableBalance: 2000, ledgerBalance: 1950 });
    });

    it('returns a failed pre-cutover payout to available, and reverses a paid one', async () => {
      const { ownerId, payout } = await cutOverMerchant();
      await givenTransaction('TRF-OLD-2');
      await givenTransaction('TRF-OLD-3');

      expect((await payoutStatus(ownerId, 'TRF-OLD-2', 'failed', '30000')).status).toBe(201);
      expect(await legacyDoc(payout._id)).toMatchObject({ availableBalance: 2300, ledgerBalance: 2350 });

      expect((await payoutStatus(ownerId, 'TRF-OLD-3', 'reversed', '10000')).status).toBe(201);
      expect(await legacyDoc(payout._id)).toMatchObject({ availableBalance: 2400, ledgerBalance: 2450 });
    });

    it('keeps native rules for transactions created after cutover', async () => {
      const { ownerId } = await cutOverMerchant();
      await givenTransaction('TRF-NEW-1', { createdAt: new Date(Date.now() + 60_000) });

      const res = await payoutStatus(ownerId, 'TRF-NEW-1', 'success');

      expect(res.status).toBe(422);
      expect(res.body.data.code).toBe('PAYOUT_NOT_INITIATED');
    });

    it('keeps native rules for a merchant who was never cut over', async () => {
      const { ownerId } = await givenLegacyMerchant();
      await givenTransaction('TRF-OLD-4');

      const res = await payoutStatus(ownerId, 'TRF-OLD-4', 'success');

      expect(res.body.data.code).toBe('PAYOUT_NOT_INITIATED');
    });

    it('keeps the legacy document in step with native ledger operations', async () => {
      const { ownerId, payout } = await cutOverMerchant();

      const res = await payoutStatus(ownerId, randomUUID(), 'initiated', '25000');

      expect(res.status).toBe(201);
      expect(await legacyDoc(payout._id)).toMatchObject({ availableBalance: 1750, ledgerBalance: 2350 });
    });

    it('settles a pre-cutover collection, and splits a batch between legacy and native items', async () => {
      const { ownerId, canonical } = await cutOverMerchant();
      await givenTransaction('COL-OLD-1');
      await givenTransaction('COL-OLD-2');

      expect((await post('/collections/settle', { collectionId: 'COL-OLD-1', ownerId, currency: 'NGN', amount: '300' })).status).toBe(201);
      expect(await legacyDoc(canonical._id)).toMatchObject({ availableBalance: 5103.25, ledgerBalance: 6300 });

      const fresh = randomUUID();
      await post('/collections/collect', { collectionId: fresh, ownerId, currency: 'NGN', amount: '500' });
      const batch = await post('/collections/settle-batch', {
        ownerId, currency: 'NGN', items: [{ collectionId: 'COL-OLD-2', amount: '200' }, { collectionId: fresh, amount: '500' }],
      });

      expect(batch.status).toBe(201);
      expect(batch.body.data.items).toHaveLength(2);
      expect(await legacyDoc(canonical._id)).toMatchObject({ availableBalance: 5110.25, ledgerBalance: 6305 });
    });

    it('resolves a pre-cutover settlement with the amount from back-end\'s record', async () => {
      const { ownerId, canonical } = await cutOverMerchant();
      await givenTransaction('SET-OLD-1', { fromAmount: 10 });

      const res = await post('/settlements/success', { settlementId: 'SET-OLD-1', ownerId, currency: 'NGN', walletType: 'collection' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ settlementId: 'SET-OLD-1', amount: '1000' });
      expect(await legacyDoc(canonical._id)).toMatchObject({ availableBalance: 5100.25, ledgerBalance: 6290 });
    });

    it('approves a pre-cutover conversion on both legs', async () => {
      const { ownerId, canonical, usdt } = await cutOverMerchant();
      await givenTransaction('CNV-OLD-1', { fromAmount: 10, toAmount: 0.25 });

      const res = await post('/conversions/approve', { conversionId: 'CNV-OLD-1', ownerId, fromCurrency: 'NGN', toCurrency: 'USDT', walletType: 'collection' });

      expect(res.status).toBe(201);
      expect(await legacyDoc(canonical._id)).toMatchObject({ ledgerBalance: 6290 });
      expect(await legacyDoc(usdt._id)).toMatchObject({ availableBalance: 0.55, ledgerBalance: 0.3 });
    });

    it('takes a pre-cutover refund out of both balances', async () => {
      const { ownerId, canonical } = await cutOverMerchant();
      await ctx.legacyDb.collection('refunds').insertOne({ merchant: new Types.ObjectId(ownerId), reference: 'REF-OLD-1', createdAt: before });

      const res = await post('/refunds/status', { refundId: 'REF-OLD-1', ownerId, currency: 'NGN', amount: '100', status: 'pending' });

      expect(res.status).toBe(201);
      expect(await legacyDoc(canonical._id)).toMatchObject({ availableBalance: 5099.25, ledgerBalance: 6299 });
    });

    it('rolls the whole post back when the legacy document cannot be updated', async () => {
      const { ownerId, payout } = await cutOverMerchant();
      await givenTransaction('TRF-OLD-5');
      // Make back-end's collection reject the new value, as a real write failure would.
      await ctx.legacyDb.command({
        collMod: 'wallets',
        validator: { $or: [{ _id: { $ne: payout._id } }, { availableBalance: { $lte: 2000 } }] },
        validationAction: 'error',
      });

      const res = await payoutStatus(ownerId, 'TRF-OLD-5', 'failed', '100');
      await ctx.legacyDb.command({ collMod: 'wallets', validator: {} });
      const balance = await request(ctx.app.getHttpServer())
        .get(`/wallets/${ownerId}/balance/NGN`).set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(500);
      expect(JSON.stringify(balance.body)).toContain('"available":"200000"');
      expect(await legacyDoc(payout._id)).toMatchObject({ availableBalance: 2000 });
    });
  });
});
