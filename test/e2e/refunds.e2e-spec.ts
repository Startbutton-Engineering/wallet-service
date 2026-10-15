import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Refunds', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close()
  })

  function post(path: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post(path)
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  async function settle(ownerId: string, amount: string) {
    const collectionId = randomUUID();
    await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount });
    return post('/collections/settle', { collectionId, ownerId, currency: 'NGN', amount });
  }

  const refund = (body: Record<string, unknown>) => post('/refunds/status', { currency: 'NGN', ...body });
  const fee = (body: Record<string, unknown>) => post('/refunds/fee/status', { currency: 'NGN', ...body });

  it('overdraws into refund-chargeback debt and repays it from the next settlement', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');

    const refunded = await refund({ refundId: randomUUID(), ownerId, amount: '150', status: 'pending', allowOverdraft: true });
    expect(refunded.status).toBe(201);
    expect(refunded.body.data.balance).toMatchObject({ available: '0', refundChargeback: '-50', ledger: '-50' });

    const settled = await settle(ownerId, '80');
    expect(settled.status).toBe(201);
    expect(settled.body.data.balance).toMatchObject({ available: '30', refundChargeback: '0', ledger: '30' });

    const events = await ctx.db.db
      .collection('outbox')
      .find({ type: 'RefundChargebackSettled', 'payload.ownerId': ownerId })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ settledToDebit: '50', amountToCredit: '30' });
  });

  it('rejects a refund larger than available without an overdraft', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');

    const res = await refund({ refundId: randomUUID(), ownerId, amount: '150', status: 'pending' });
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('keeps the debt when the refund succeeds', async () => {
    const ownerId = randomUUID();
    const refundId = randomUUID();
    await settle(ownerId, '100');

    await refund({ refundId, ownerId, amount: '150', status: 'pending', allowOverdraft: true });
    const res = await refund({ refundId, ownerId, amount: '150', status: 'success' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '0', refundChargeback: '-50', ledger: '-50' });
  });

  it('puts available and the debt back exactly when the refund fails', async () => {
    const ownerId = randomUUID();
    const refundId = randomUUID();
    await settle(ownerId, '100');

    await refund({ refundId, ownerId, amount: '150', status: 'pending', allowOverdraft: true });
    const res = await refund({ refundId, ownerId, amount: '150', status: 'failed' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '100', refundChargeback: '0', ledger: '100' });
  });

  it('refuses to resolve a refund twice', async () => {
    const ownerId = randomUUID();
    const refundId = randomUUID();
    await settle(ownerId, '100');

    await refund({ refundId, ownerId, amount: '50', status: 'pending' });
    await refund({ refundId, ownerId, amount: '50', status: 'success' });
    const res = await refund({ refundId, ownerId, amount: '50', status: 'failed' });

    expect(res.status).toBe(409);
  });

  it('repays debt from a payout -> collection transfer', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '200');
    await post('/wallets/transfer', {
      transferId: randomUUID(), ownerId, currency: 'NGN', amount: '200', from: 'collection', to: 'payout',
    });
    await refund({ refundId: randomUUID(), ownerId, amount: '60', status: 'pending', allowOverdraft: true });

    const res = await post('/wallets/transfer', {
      transferId: randomUUID(), ownerId, currency: 'NGN', amount: '100', from: 'payout', to: 'collection',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.destination).toMatchObject({ available: '40', refundChargeback: '0' });
    expect(res.body.data.source).toMatchObject({ available: '100' });
  });

  it('finds refund entries by refundId', async () => {
    const ownerId = randomUUID();
    const refundId = randomUUID();
    await settle(ownerId, '100');
    await refund({ refundId, ownerId, amount: '40', status: 'pending' });

    const res = await request(ctx.app.getHttpServer())
      .get('/entries')
      .query({ refundId })
      .set('x-api-key', TEST_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].operationType).toBe('refund.pending');
  });

  describe('transfer fee', () => {
    /** A refund already set to pending, so its transfer fee can be charged. */
    async function givenPendingRefund(settled: string, refunded: string) {
      const ownerId = randomUUID();
      const refundId = randomUUID();
      const transferReference = `trf_${refundId}`;
      await settle(ownerId, settled);
      const res = await refund({ refundId, ownerId, amount: refunded, status: 'pending' });
      expect(res.status).toBe(201);
      return { ownerId, refundId, transferReference };
    }

    function systemRefundsBalance(): Promise<bigint> {
      return ctx.db.db
        .collection('accounts')
        .findOne({ ownerId: null, walletType: null, accountType: 'external:refunds', currency: 'NGN' })
        .then((doc) => (doc ? BigInt(doc.balance.toString()) : 0n));
    }

    it('holds the fee on initiated: available drops, heldOutflow rises, ledger unchanged', async () => {
      const r = await givenPendingRefund('1000', '400');

      const res = await fee({ ...r, amount: '50', status: 'initiated' });

      expect(res.status).toBe(201);
      expect(res.body.data.balance).toMatchObject({ available: '550', heldOutflow: '50', ledger: '600' });
    });

    it('charges the fee to external:refunds on success', async () => {
      const r = await givenPendingRefund('1000', '400');
      const before = await systemRefundsBalance();

      await fee({ ...r, amount: '50', status: 'initiated' });
      const res = await fee({ ...r, amount: '50', status: 'success' });

      expect(res.status).toBe(201);
      expect(res.body.data.balance).toMatchObject({ available: '550', heldOutflow: '0', ledger: '550' });
      expect((await systemRefundsBalance()) - before).toBe(50n);
    });

    it('returns the fee to available when the transfer is reversed, then re-charges it on reverse-failed', async () => {
      const r = await givenPendingRefund('1000', '400');

      await fee({ ...r, amount: '50', status: 'initiated' });
      const reversed = await fee({ ...r, amount: '50', status: 'reversed' });
      expect(reversed.body.data.balance).toMatchObject({ available: '600', heldOutflow: '0', ledger: '600' });

      const reverseFailed = await fee({ ...r, amount: '50', status: 'reverse-failed' });
      expect(reverseFailed.status).toBe(201);
      expect(reverseFailed.body.data.balance).toMatchObject({ available: '550', ledger: '550' });
    });

    it('never overdraws for the fee', async () => {
      const r = await givenPendingRefund('100', '100');

      const res = await fee({ ...r, amount: '50', status: 'initiated' });

      expect(res.status).toBe(422);
      expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('refuses a fee for a refund that was never set to pending', async () => {
      const ownerId = randomUUID();
      await settle(ownerId, '100');

      const res = await fee({ refundId: randomUUID(), transferReference: randomUUID(), ownerId, amount: '10', status: 'initiated' });

      expect(res.status).toBe(422);
      expect(res.body.data.code).toBe('REFUND_NOT_INITIATED');
    });

    it('leaves the refund itself resolvable after its fee is charged', async () => {
      const r = await givenPendingRefund('1000', '400');
      await fee({ ...r, amount: '50', status: 'initiated' });
      await fee({ ...r, amount: '50', status: 'success' });

      const res = await refund({ refundId: r.refundId, ownerId: r.ownerId, amount: '400', status: 'success' });

      expect(res.status).toBe(201);
      expect(res.body.data.balance).toMatchObject({ available: '550', ledger: '550' });
    });

    it('records the refund on the fee entry metadata', async () => {
      const r = await givenPendingRefund('1000', '400');
      await fee({ ...r, amount: '50', status: 'initiated' });

      const res = await request(ctx.app.getHttpServer())
        .get('/entries')
        .query({ refundTransferReference: r.transferReference })
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]).toMatchObject({
        operationType: 'refund.fee.initiate',
        reference: r.transferReference,
        metadata: { refundId: r.refundId, transferReference: r.transferReference, purpose: 'refund-transfer-fee' },
      });
    });
  });
});
