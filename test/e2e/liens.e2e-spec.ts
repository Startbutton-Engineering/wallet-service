import { randomUUID } from "crypto";
import { Types } from "mongoose";
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

  it('replaces the held lien rather than adding to it, as legacy does', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '1000');
    await lien('place', ownerId, '400');

    const raised = await lien('place', ownerId, '600');
    expect(raised.status).toBe(201);
    expect(raised.body.data.balance).toMatchObject({ available: '400', lien: '600', ledger: '1000' });

    const lowered = await lien('place', ownerId, '100');
    expect(lowered.status).toBe(201);
    expect(lowered.body.data.balance).toMatchObject({ available: '900', lien: '100', ledger: '1000' });

    const same = await lien('place', ownerId, '100');
    expect(same.status).toBe(201);
    expect(same.body.data.entryId).toBeNull();
    expect(same.body.data.balance).toMatchObject({ available: '900', lien: '100' });
  });

  it('checks a raised lien against what is spendable plus what is already held', async () => {
    const ownerId = randomUUID();
    await topup(ownerId, '1000');
    await lien('place', ownerId, '400');

    expect((await lien('place', ownerId, '1000')).status).toBe(201);
    const over = await lien('place', ownerId, '1001');
    expect(over.status).toBe(422);
    expect(over.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('mirrors the replaced lien onto a cut-over legacy wallet', async () => {
    const merchantId = new Types.ObjectId();
    const ownerId = merchantId.toHexString();
    const walletId = new Types.ObjectId();
    await ctx.legacyDb.collection('wallets').insertOne({
      _id: walletId, merchantId, type: 'payout', currency: 'NGN', createdAt: new Date('2025-01-01'),
      availableBalance: 1000, ledgerBalance: 1000, lienBalance: 300, refundsOrChargeBackBalance: 0, rollingReserveOverdraftBalance: 0,
    });
    expect((await post('/migrations/cutover', { ownerId })).status).toBe(201);

    const res = await lien('place', ownerId, '50000');

    expect(res.status).toBe(201);
    expect(res.body.data.balance).toMatchObject({ available: '50000', lien: '50000' });
    expect(await ctx.legacyDb.collection('wallets').findOne({ _id: walletId })).toMatchObject({
      availableBalance: 1000, ledgerBalance: 1000, lienBalance: 500,
    });
  });
});
