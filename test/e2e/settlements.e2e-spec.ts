import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import { AccountDoc, System } from "../../src/accounts/account";
import { loadConfig } from "../../src/config";

describe('Settlements', () => {
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

  function get(path: string) {
    return request(ctx.app.getHttpServer()).get(path).set('x-api-key', TEST_API_KEY);
  }

  const initiate = (body: Record<string, unknown>, key = randomUUID() as string) =>
    post('/settlements/initiate', body, key);
  const succeed = (body: Record<string, unknown>, key = randomUUID() as string) =>
    post('/settlements/success', body, key);
  const fail = (body: Record<string, unknown>, key = randomUUID() as string) =>
    post('/settlements/fail', body, key);

  async function givenCollectionWallet(amount: string, currency = 'USD'): Promise<string> {
    const ownerId = randomUUID();
    const collectionId = randomUUID();
    await post('/collections/collect', { collectionId, ownerId, currency, amount });
    const res = await post('/collections/settle', { collectionId, ownerId, currency, amount });
    expect(res.status).toBe(201);
    return ownerId;
  }

  async function payoutBalance(currency: string): Promise<bigint> {
    const doc = await ctx.db.db.collection<AccountDoc>('accounts').findOne({
      tenantId: loadConfig().defaultTenantId,
      kind: 'system',
      accountType: System.payout,
      currency,
    });
    return doc ? BigInt(doc.balance.toString()) : 0n;
  }

  it('holds funds on initiate: available drops, heldOutflow rises, ledger unchanged', async () => {
    const ownerId = await givenCollectionWallet('50000');

    const res = await initiate({ settlementId: randomUUID(), ownerId, currency: 'USD', amount: '10500' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'initiated', amount: '10500', walletType: 'collection' });
    expect(res.body.data.balance.available).toBe('39500');
    expect(res.body.data.balance.heldOutflow).toBe('10500');
    expect(res.body.data.balance.ledger).toBe('50000');
  });

  it('success releases the hold to external:payout', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();
    const before = await payoutBalance('USD');

    await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' });
    const res = await succeed({ settlementId, ownerId, currency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'success', amount: '10500' });
    expect(res.body.data.balance.heldOutflow).toBe('0');
    expect(res.body.data.balance.available).toBe('39500');
    expect(res.body.data.balance.ledger).toBe('39500');
    expect((await payoutBalance('USD')) - before).toBe(10_500n);
  });

  it('failed returns the hold to available', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();
    const before = await payoutBalance('USD');

    await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' });
    const res = await fail({ settlementId, ownerId, currency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'failed', amount: '10500' });
    expect(res.body.data.balance.heldOutflow).toBe('0');
    expect(res.body.data.balance.available).toBe('50000');
    expect(await payoutBalance('USD')).toBe(before);
  });

  it('works from any wallet currency', async () => {
    const ownerId = await givenCollectionWallet('50000', 'NGN');
    const settlementId = randomUUID();

    await initiate({ settlementId, ownerId, currency: 'NGN', amount: '20000' });
    const res = await succeed({ settlementId, ownerId, currency: 'NGN' });

    expect(res.status).toBe(201);
    expect(res.body.data.balance.available).toBe('30000');
  });

  it('rejects an initiate larger than available with 422 INSUFFICIENT_FUNDS', async () => {
    const ownerId = await givenCollectionWallet('5000');

    const res = await initiate({ settlementId: randomUUID(), ownerId, currency: 'USD', amount: '10500' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects a second initiate for the same settlement with 409', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();

    await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' });
    const res = await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' });

    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('SETTLEMENT_ALREADY_INITIATED');
  });

  it('rejects resolving a settlement that was never initiated with 422', async () => {
    const ownerId = await givenCollectionWallet('50000');

    const res = await succeed({ settlementId: randomUUID(), ownerId, currency: 'USD' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('SETTLEMENT_NOT_INITIATED');
  });

  it('rejects resolving an already resolved settlement with 409', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();

    await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' });
    await succeed({ settlementId, ownerId, currency: 'USD' });
    const res = await fail({ settlementId, ownerId, currency: 'USD' });

    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('SETTLEMENT_ALREADY_RESOLVED');
  });

  it('replays the same idempotency key without posting twice', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();
    const key = randomUUID();

    const first = await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' }, key);
    const second = await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500' }, key);

    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
    expect(second.body.data.balance.available).toBe('39500');
  });

  it('lists a settlement as pending only until it is resolved', async () => {
    const ownerId = await givenCollectionWallet('50000');
    const settlementId = randomUUID();

    await initiate({ settlementId, ownerId, currency: 'USD', amount: '10500', walletType: 'collection' });
    const pending = await get('/settlements/pending?limit=200');
    expect(pending.status).toBe(200);
    expect(pending.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ settlementId, ownerId, currency: 'USD', amount: '10500', walletType: 'collection' }),
      ]),
    );

    await fail({ settlementId, ownerId, currency: 'USD' });
    const after = await get('/settlements/pending?limit=200');
    expect(after.body.data.map((s: { settlementId: string }) => s.settlementId)).not.toContain(settlementId);
  });
});
