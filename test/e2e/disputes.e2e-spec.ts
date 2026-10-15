import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Disputes', () => {
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

  const accept = (body: Record<string, unknown>, idempotencyKey?: string) =>
    post('/disputes/accept', { currency: 'NGN', ...body }, idempotencyKey);

  function systemCollectionBalance(): Promise<bigint> {
    return ctx.db.db
      .collection('accounts')
      .findOne({ ownerId: null, walletType: null, accountType: 'external:collection', currency: 'NGN' })
      .then((doc) => (doc ? BigInt(doc.balance.toString()) : 0n));
  }

  it('debits available and sends the amount back out through external:collection', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');
    const before = await systemCollectionBalance();

    const res = await accept({ disputeId: randomUUID(), ownerId, amount: '40' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Dispute accepted');
    expect(res.body.data).toMatchObject({ fromAvailable: '40', deficit: '0' });
    expect(res.body.data.balance).toMatchObject({ available: '60', refundChargeback: '0', ledger: '60' });
    expect((await systemCollectionBalance()) - before).toBe(40n);
  });

  it('overdraws into refund-chargeback debt and repays it from the next settlement', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');

    const accepted = await accept({ disputeId: randomUUID(), ownerId, amount: '150', allowOverdraft: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data).toMatchObject({ fromAvailable: '100', deficit: '50' });
    expect(accepted.body.data.balance).toMatchObject({ available: '0', refundChargeback: '-50', ledger: '-50' });

    const settled = await settle(ownerId, '80');
    expect(settled.status).toBe(201);
    expect(settled.body.data).toMatchObject({ settledToDebit: '50' });
    expect(settled.body.data.balance).toMatchObject({ available: '30', refundChargeback: '0', ledger: '30' });
  });

  it('rejects a dispute larger than available without an overdraft', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');

    const res = await accept({ disputeId: randomUUID(), ownerId, amount: '150' });
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('replays the same idempotency key and refuses a second accept under a new key', async () => {
    const ownerId = randomUUID();
    const disputeId = randomUUID();
    await settle(ownerId, '100');

    const first = await accept({ disputeId, ownerId, amount: '30' }, 'dsp-key');
    const replay = await accept({ disputeId, ownerId, amount: '30' }, 'dsp-key');
    expect(replay.status).toBe(201);
    expect(replay.body.data.operationId).toBe(first.body.data.operationId);

    const again = await accept({ disputeId, ownerId, amount: '30' });
    expect(again.status).toBe(409);
    expect(again.body.data.code).toBe('DISPUTE_ALREADY_ACCEPTED');
  });
});
