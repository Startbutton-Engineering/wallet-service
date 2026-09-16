import { randomUUID } from "crypto";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import request from 'supertest';
import { Types } from "mongoose";
import { AccountDoc, System } from "../../src/accounts/account";
import { loadConfig } from "../../src/config";

describe('Payouts', () => {
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

  const status = (body: Record<string, unknown>, key = randomUUID() as string) => post('/payouts/status', body, key);

  /** Collect + settle into the collection wallet, then move it across to the payout wallet. */
  async function givenPayoutWallet(amount: string): Promise<string> {
    const ownerId = randomUUID();
    const collectionId = randomUUID();
    await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount });
    await post('/collections/settle', { collectionId, ownerId, currency: 'NGN', amount });
    const res = await post('/wallets/transfer', {
      transferId: randomUUID(), ownerId, currency: 'NGN', amount, from: 'collection', to: 'payout',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.destination.available).toBe(amount);
    expect(res.body.data.source.available).toBe('0');
    return ownerId;
  }

  function systemPayoutBalance(): Promise<AccountDoc | null> {
    return ctx.db.db.collection<AccountDoc>('accounts').findOne({
      tenantId: loadConfig().defaultTenantId,
      ownerId: null,
      walletType: null,
      accountType: System.payout,
      currency: 'NGN',
    }) as Promise<AccountDoc | null>;
  }

  it('holds funds on initiate: available drops, heldOutflow rises, ledger unchanged', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const res = await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('39500');
    expect(res.body.data.balance.heldOutflow).toBe('10500');
    expect(res.body.data.balance.ledger).toBe('50000');
  });

  it('clears the hold on success and credits the external payout account', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();
    const before = await systemPayoutBalance();
    const beforeBalance = before ? BigInt(before.balance.toString()) : 0n;

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'success' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('39500');
    expect(res.body.data.balance.heldOutflow).toBe('0');
    expect(res.body.data.balance.ledger).toBe('39500');

    const after = await systemPayoutBalance();
    expect(BigInt(after!.balance.toString()) - beforeBalance).toBe(10500n);
  });

  it('returns the hold to available on failure, leaving the ledger untouched', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'failed' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('50000');
    expect(res.body.data.balance.heldOutflow).toBe('0');
    expect(res.body.data.balance.ledger).toBe('50000');
  });

  it('refunds available when a successful payout is reversed', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'success' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reversed' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('50000');
    expect(res.body.data.balance.ledger).toBe('50000');
  });

  it('points the reversal entry at the success entry it undoes', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    const success = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'success' });
    const reversal = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reversed' });

    // The raw driver does no mongoose casting, so a hex string here would silently
    // match nothing and findOne would return null.
    const entry = await ctx.db.db
      .collection('entries')
      .findOne({ _id: new Types.ObjectId(reversal.body.data.entryId) } as never);
    expect(entry).not.toBeNull();
    expect(String(entry!.reversalOf)).toBe(success.body.data.entryId);
  });

  it('re-debits available on reverse-failed after a failure (late success webhook)', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'failed' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reverse-failed' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('39500');
    expect(res.body.data.balance.ledger).toBe('39500');
  });

  it('allows reversing again after a reverse-failed, since the payout stands as paid out', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();
    const body = { payoutId, ownerId, currency: 'NGN', amount: '10500' };

    await status({ ...body, status: 'initiated' });
    await status({ ...body, status: 'success' });
    await status({ ...body, status: 'reversed' });
    await status({ ...body, status: 'reverse-failed' });
    const res = await status({ ...body, status: 'reversed' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('50000');
  });

  it('rejects initiating more than the payout wallet holds', async () => {
    const ownerId = await givenPayoutWallet('1000');
    const res = await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '1001', status: 'initiated' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects initiating the same payoutId twice under different idempotency keys', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    const first = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    expect(first.status).toBe(201);

    const second = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    expect(second.status).toBe(409);
    expect(second.body.data.code).toBe('PAYOUT_ALREADY_INITIATED');
  });

  it('rejects a success for an amount other than the held amount', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10000', status: 'success' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('PAYOUT_AMOUNT_MISMATCH');
    expect(res.body.data.details.outstanding).toBe('10500');
  });

  it('rejects a success for a payout that was never initiated', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const res = await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '10500', status: 'success' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('PAYOUT_NOT_INITIATED');
  });

  it('rejects resolving a payout twice', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'success' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'failed' });

    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('PAYOUT_ALREADY_RESOLVED');
  });

  it('rejects reversing a payout that never succeeded', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reversed' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('PAYOUT_NOT_SUCCESSFUL');
  });

  it('rejects reverse-failed when nothing was returned to the owner', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'success' });
    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reverse-failed' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('PAYOUT_NOT_REVERSED');
  });

  it('rejects reverse-failed when the owner has already spent the refund', async () => {
    const ownerId = await givenPayoutWallet('10500');
    const payoutId = randomUUID();
    const otherPayoutId = randomUUID();

    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });
    await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'failed' });
    // the refunded funds get committed to a different payout
    await status({ payoutId: otherPayoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' });

    const res = await status({ payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'reverse-failed' });
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('replays the stored result for a repeated idempotency key without moving money again', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const payoutId = randomUUID();
    const key = randomUUID();
    const body = { payoutId, ownerId, currency: 'NGN', amount: '10500', status: 'initiated' };

    const first = await status(body, key);
    const second = await status(body, key);

    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(second.body.data.balance.available).toBe('39500');
  });

  it('rejects reusing an idempotency key with a different body', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const key = randomUUID();

    await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '10500', status: 'initiated' }, key);
    const res = await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '200', status: 'initiated' }, key);

    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('rejects an unknown status', async () => {
    const ownerId = await givenPayoutWallet('50000');
    const res = await status({ payoutId: randomUUID(), ownerId, currency: 'NGN', amount: '10500', status: 'pending' });

    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('VALIDATION_FAILED');
  });
})
