import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Topups', () => {
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

  const topup = (ownerId: string, amount: string, topupId: string = randomUUID()) =>
    post('/topups/credit', { topupId, ownerId, currency: 'NGN', amount });
  const lien = (ownerId: string, amount: string, lienId = randomUUID()) =>
    post('/liens/place', { lienId, ownerId, walletType: 'payout', currency: 'NGN', amount }, lienId);
  const payoutBalance = async (ownerId: string) => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/wallets/${ownerId}/balance/NGN`)
      .set('x-api-key', TEST_API_KEY);
    return res.body.data.find((balance: { walletType: string }) => balance.walletType === 'payout');
  };

  it('takes a negative amount from the wallet when the balance covers it', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '60000');

    const res = await topup(ownerId, '-50000');

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '10000', ledger: '10000' });
  });

  it('lets a negative amount take the balance to exactly zero', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '50000');

    const res = await topup(ownerId, '-50000');

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '0', ledger: '0' });
  });

  it('rejects a negative amount larger than the balance and leaves the balance alone', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '10000');

    const res = await topup(ownerId, '-20000');

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
    expect(await payoutBalance(ownerId)).toMatchObject({ available: '10000', ledger: '10000' });
  });

  it('rejects a negative amount for an owner with no balance', async () => {
    const res = await topup(randomUUID(), '-1');

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('can retry a rejected negative amount under the same key once the wallet is funded', async () => {
    const ownerId = randomUUID();
    const topupId = randomUUID();
    const idempotencyKey = randomUUID();
    const attempt = () => post('/topups/credit', { topupId, ownerId, currency: 'NGN', amount: '-500' }, idempotencyKey);

    expect((await attempt()).status).toBe(422);
    await topup(ownerId, '600');

    const res = await attempt();

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '100' });
  });

  it('does not let a negative amount spend a liened balance', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '1000');
    await lien(ownerId, '400');

    const blocked = await topup(ownerId, '-700');
    expect(blocked.status).toBe(422);
    expect(blocked.body.data.code).toBe('INSUFFICIENT_FUNDS');

    const allowed = await topup(ownerId, '-600');
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.balance).toMatchObject({ available: '0', lien: '400' });
  });

  it('applies a negative topup id only once, whatever the idempotency key', async () => {
    const ownerId = randomUUID();
    const topupId = randomUUID();
    await topup(ownerId, '1000');

    expect((await topup(ownerId, '-100', topupId)).status).toBe(201);
    const repeat = await topup(ownerId, '-100', topupId);

    expect(repeat.status).toBe(409);
    expect(repeat.body.data.code).toBe('TOPUP_ALREADY_CREDITED');
    expect(await payoutBalance(ownerId)).toMatchObject({ available: '900' });
  });

  it.each(['0', '1.5', 'abc'])('rejects the amount %p as invalid', async (amount) => {
    const res = await topup(randomUUID(), amount);

    expect(res.status).toBe(400);
  });
});
