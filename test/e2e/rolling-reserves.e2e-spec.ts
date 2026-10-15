import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Rolling reserves', () => {
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

  const release = (body: Record<string, unknown>, idempotencyKey?: string) =>
    post('/rolling-reserves/release', { currency: 'NGN', ...body }, idempotencyKey);

  function systemCollectionBalance(): Promise<bigint> {
    return ctx.db.db
      .collection('accounts')
      .findOne({ ownerId: null, walletType: null, accountType: 'external:collection', currency: 'NGN' })
      .then((doc) => (doc ? BigInt(doc.balance.toString()) : 0n));
  }

  it('credits both balances from external:collection', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');
    const before = await systemCollectionBalance();

    const res = await release({ releaseId: randomUUID(), ownerId, amount: '30' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Rolling reserve released');
    expect(res.body.data).toMatchObject({ settledToDebit: '0', amountToCredit: '30' });
    expect(res.body.data.balance).toMatchObject({ available: '130', ledger: '130' });
    expect((await systemCollectionBalance()) - before).toBe(-30n);
  });

  it('repays refund-chargeback debt first', async () => {
    const ownerId = randomUUID();
    await settle(ownerId, '100');
    await post('/disputes/accept', { disputeId: randomUUID(), ownerId, currency: 'NGN', amount: '150', allowOverdraft: true });

    const res = await release({ releaseId: randomUUID(), ownerId, amount: '80' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ settledToDebit: '50', amountToCredit: '30' });
    expect(res.body.data.balance).toMatchObject({ available: '30', refundChargeback: '0', ledger: '30' });
  });

  it('replays the same idempotency key and refuses a second release under a new key', async () => {
    const ownerId = randomUUID();
    const releaseId = randomUUID();

    const first = await release({ releaseId, ownerId, amount: '30' }, 'rr-key');
    const replay = await release({ releaseId, ownerId, amount: '30' }, 'rr-key');
    expect(replay.status).toBe(201);
    expect(replay.body.data.operationId).toBe(first.body.data.operationId);

    const again = await release({ releaseId, ownerId, amount: '30' });
    expect(again.status).toBe(409);
    expect(again.body.data.code).toBe('ROLLING_RESERVE_ALREADY_RELEASED');
  });
});
