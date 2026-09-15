import { randomUUID } from "crypto";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import request from 'supertest';
import { AccountDoc, userAccountId, USER_ACCOUNT_TYPES } from "../../src/accounts/account";

describe('Wallets', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close()
  })

  function createWallet(body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer())
      .post('/wallets')
      .set('x-api-key', TEST_API_KEY)
      .send(body);
  }

  function getBalance(ownerId: string, currency: string) {
    return request(ctx.app.getHttpServer())
      .get(`/wallets/${ownerId}/balance/${currency}`)
      .set('x-api-key', TEST_API_KEY);
  }

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

  it('provisions disjoint account sets for the collection and payout wallets', async () => {
    const ownerId = randomUUID();

    const collectionRes = await createWallet({ ownerId, currency: 'NGN', walletType: 'collection' });
    expect(collectionRes.status).toBe(201);
    expect(collectionRes.body.data.walletType).toBe('collection');

    const payoutRes = await createWallet({ ownerId, currency: 'NGN', walletType: 'payout' });
    expect(payoutRes.status).toBe(201);
    expect(payoutRes.body.data.walletType).toBe('payout');

    const docs = await ctx.db
      .collection<AccountDoc>('accounts')
      .find({ ownerId })
      .toArray();

    // One sub-account per type, per wallet type — and no id shared between the two wallets.
    expect(docs).toHaveLength(USER_ACCOUNT_TYPES.length * 2);
    expect(new Set(docs.map((d) => d._id)).size).toBe(docs.length);
    expect(docs.filter((d) => d.walletType === 'collection')).toHaveLength(USER_ACCOUNT_TYPES.length);
    expect(docs.filter((d) => d.walletType === 'payout')).toHaveLength(USER_ACCOUNT_TYPES.length);

    expect(docs.map((d) => d._id)).toContain(userAccountId('', ownerId, 'NGN', 'collection', 'available'));
    expect(docs.map((d) => d._id)).toContain(userAccountId('', ownerId, 'NGN', 'payout', 'available'));
  });

  it('keeps collection money out of the payout wallet', async () => {
    const ownerId = randomUUID();
    const collectionId = randomUUID();
    await createWallet({ ownerId, currency: 'NGN', walletType: 'payout' });

    await collect({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    const settleRes = await settle({ collectionId, ownerId, currency: 'NGN', amount: '1000' });
    expect(settleRes.status).toBe(201);
    expect(settleRes.body.data.balance.walletType).toBe('collection');

    const res = await getBalance(ownerId, 'NGN');
    expect(res.status).toBe(200);
    const collection = res.body.data.find((w: { walletType: string }) => w.walletType === 'collection');
    const payout = res.body.data.find((w: { walletType: string }) => w.walletType === 'payout');
    expect(collection.available).toBe('1000');
    expect(collection.heldInflow).toBe('0');
    // The whole point of the split: the payout wallet is untouched by a collection.
    expect(payout.available).toBe('0');
    expect(payout.ledger).toBe('0');
  });

  it('returns one entry per wallet type, each tagged with its type', async () => {
    const ownerId = randomUUID();
    await createWallet({ ownerId, currency: 'NGN', walletType: 'collection' });
    await createWallet({ ownerId, currency: 'NGN', walletType: 'payout' });

    const res = await getBalance(ownerId, 'NGN');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.map((w: { walletType: string }) => w.walletType)).toEqual(['collection', 'payout']);
    for (const wallet of res.body.data) {
      expect(wallet.ownerId).toBe(ownerId);
      expect(wallet.currency).toBe('NGN');
    }
  });

  it('omits a wallet type the owner was never provisioned for', async () => {
    const ownerId = randomUUID();
    await createWallet({ ownerId, currency: 'NGN', walletType: 'collection' });

    const res = await getBalance(ownerId, 'NGN');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].walletType).toBe('collection');
  });

  it('404s when the owner has neither wallet type', async () => {
    const res = await getBalance(randomUUID(), 'NGN');
    expect(res.status).toBe(404);
    expect(res.body.data.code).toBe('NOT_FOUND');
  });

  it('rejects an unknown walletType', async () => {
    const res = await createWallet({ ownerId: randomUUID(), currency: 'NGN', walletType: 'savings' });
    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('VALIDATION_FAILED');
  });

  it('wraps a success in the standard envelope', async () => {
    const res = await createWallet({ ownerId: randomUUID(), currency: 'NGN', walletType: 'collection' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Wallet created');
    expect(res.body.data.walletType).toBe('collection');
  });

  it('wraps a failure in the standard envelope', async () => {
    const res = await getBalance(randomUUID(), 'NGN');
    expect(res.status).toBe(404);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.data.code).toBe('NOT_FOUND');
    expect(res.body.data.retryable).toBe(false);
  });
})
