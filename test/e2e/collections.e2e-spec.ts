import { randomUUID } from "crypto";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import request from 'supertest';

describe('Collections', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close()
  })

  function collect(body: Record<string, unknown>, idempotencyKey = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post('/collections/collect')
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  function settle(body: Record<string, unknown>, idempotencyKey = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post('/collections/settle')
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  it('collects then settles the full amount successfully', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();

    const collectRes = await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(collectRes.status).toBe(201);
    expect(collectRes.body.data.balance.heldInflow).toBe('1000');

    const settleRes = await settle({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(settleRes.status).toBe(201);
    expect(settleRes.body.data.balance.heldInflow).toBe('0');
    expect(settleRes.body.data.balance.available).toBe('1000');
  });

  it('rejects settling a collectionId that was never collected', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();

    const res = await settle({ collectionId, ownerId, currency: 'NGN', amount: '500' });
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('COLLECTION_OVER_SETTLEMENT');
  });

  it('rejects settling the same collectionId a second time', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();

    await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    const firstSettle = await settle({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(firstSettle.status).toBe(201);

    const secondSettle = await settle({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(secondSettle.status).toBe(422);
    expect(secondSettle.body.data.code).toBe('COLLECTION_OVER_SETTLEMENT');
  });

  it('rejects settling more than was collected for a collectionId', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();

    await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    const res = await settle({ collectionId, ownerId, currency: 'NGN', amount: '1500' });
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('COLLECTION_OVER_SETTLEMENT');
  });

  it('rejects collecting the same collectionId twice, even with a different idempotency key', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();

    const first = await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(first.status).toBe(201);

    const second = await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(second.status).toBe(409);
    expect(second.body.data.code).toBe('COLLECTION_ALREADY_RECEIVED');
  });
})
