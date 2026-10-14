import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Liens', () => {
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

  const topup = (ownerId: string, amount: string) =>
    post('/topups/credit', { topupId: randomUUID(), ownerId, currency: 'NGN', amount });
  const lien = (action: 'place' | 'release', ownerId: string, amount: string, lienId = randomUUID()) =>
    post(`/liens/${action}`, { lienId, ownerId, walletType: 'payout', currency: 'NGN', amount }, lienId);
  const payout = (ownerId: string, amount: string) =>
    post('/payouts/status', { payoutId: randomUUID(), ownerId, currency: 'NGN', amount, status: 'initiated' });

  it('keeps a liened amount in the ledger but out of reach of a payout until it is released', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '1000');

    const placed = await lien('place', ownerId, '400');
    expect(placed.status).toBe(201);
    expect(placed.body.data.balance).toMatchObject({ available: '600', lien: '400', ledger: '1000' });

    const blocked = await payout(ownerId, '700');
    expect(blocked.status).toBe(422);
    expect(blocked.body.data.code).toBe('INSUFFICIENT_FUNDS');

    const allowed = await payout(ownerId, '600');
    expect(allowed.status).toBe(201);

    const released = await lien('release', ownerId, '400');
    expect(released.status).toBe(201);
    expect(released.body.data.balance).toMatchObject({ available: '400', lien: '0' });
  });

  it('rejects a lien larger than the spendable balance', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '100');

    const res = await lien('place', ownerId, '150');
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('does not release more than is held', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '100');
    await lien('place', ownerId, '40');

    const res = await lien('release', ownerId, '50');
    expect(res.status).toBe(422);
  });

  it('places a lien id only once, whatever the idempotency key', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '100');
    const lienId = randomUUID();
    await lien('place', ownerId, '40', lienId);

    const again = await post('/liens/place', { lienId, ownerId, walletType: 'payout', currency: 'NGN', amount: '40' });
    expect(again.status).toBe(409);
    expect(again.body.data.code).toBe('LIEN_ALREADY_PLACED');
  });
});
