import { randomUUID } from "crypto";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import request from 'supertest';
import { AccountDoc, System } from "../../src/accounts/account";
import { loadConfig } from "../../src/config";

describe('Conversions', () => {
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
    post('/conversions/initiate', body, key);
  const approve = (body: Record<string, unknown>, key = randomUUID() as string) =>
    post('/conversions/approve', body, key);
  const reject = (body: Record<string, unknown>, key = randomUUID() as string) =>
    post('/conversions/reject', body, key);

  /** Collect + settle into the collection wallet, in whichever currency the test needs. */
  async function givenCollectionWallet(amount: string, currency = 'NGN'): Promise<string> {
    const ownerId = randomUUID();
    const collectionId = randomUUID();
    await post('/collections/collect', { collectionId, ownerId, currency, amount });
    const res = await post('/collections/settle', { collectionId, ownerId, currency, amount });
    expect(res.status).toBe(201);
    return ownerId;
  }

  /** Collect into the collection wallet, then move it over to the payout wallet, in
   * whichever currency the test needs. */
  async function givenPayoutWallet(amount: string, currency = 'NGN'): Promise<string> {
    const ownerId = await givenCollectionWallet(amount, currency);
    const res = await post('/wallets/transfer', {
      transferId: randomUUID(), ownerId, currency, amount, from: 'collection', to: 'payout',
    });
    expect(res.status).toBe(201);
    return ownerId;
  }

  function systemBalance(name: string, currency: string): Promise<AccountDoc | null> {
    return ctx.db.db.collection<AccountDoc>('accounts').findOne({
      tenantId: loadConfig().defaultTenantId,
      kind: 'system',
      accountType: name,
      currency,
    }) as Promise<AccountDoc | null>;
  }

  it('holds funds on initiate: fromCurrency available drops, fromCurrency held-inflow rises, toCurrency held-inflow is fronted from its fx account', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const beforeFx = await systemBalance(System.fx('USD'), 'USD');
    const beforeFxBalance = beforeFx ? BigInt(beforeFx.balance.toString()) : 0n;

    const res = await initiate({
      conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.toAmount).toBe('100');
    expect(res.body.data.fromBalance.available).toBe('350000');
    expect(res.body.data.fromBalance.heldInflow).toBe('150000');
    expect(res.body.data.fromBalance.ledger).toBe('500000');
    expect(res.body.data.toBalance.heldInflow).toBe('100');

    const afterFx = await systemBalance(System.fx('USD'), 'USD');
    // fx:USD was debited to front the toCurrency leg, so its balance moves down, not up.
    expect(BigInt(afterFx!.balance.toString()) - beforeFxBalance).toBe(-100n);
  });

  it('approve settles fromCurrency to its fx account and releases toCurrency to available', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const conversionId = randomUUID();
    const beforeFxNgn = await systemBalance(System.fx('NGN'), 'NGN');
    const beforeFxNgnBalance = beforeFxNgn ? BigInt(beforeFxNgn.balance.toString()) : 0n;

    await initiate({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500' });
    const res = await approve({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.data.fromBalance.heldInflow).toBe('0');
    expect(res.body.data.toBalance.heldInflow).toBe('0');
    expect(res.body.data.toBalance.available).toBe('100');

    const afterFxNgn = await systemBalance(System.fx('NGN'), 'NGN');
    expect(BigInt(afterFxNgn!.balance.toString()) - beforeFxNgnBalance).toBe(150_000n);
  });

  it('reject fully reverses initiate', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const conversionId = randomUUID();
    const beforeFxUsd = await systemBalance(System.fx('USD'), 'USD');
    const beforeFxUsdBalance = beforeFxUsd ? BigInt(beforeFxUsd.balance.toString()) : 0n;

    await initiate({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500' });
    const res = await reject({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.data.fromBalance.available).toBe('500000');
    expect(res.body.data.fromBalance.heldInflow).toBe('0');
    expect(res.body.data.toBalance.heldInflow).toBe('0');
    expect(res.body.data.toBalance.available).toBe('0');

    const afterFxUsd = await systemBalance(System.fx('USD'), 'USD');
    expect(BigInt(afterFxUsd!.balance.toString())).toBe(beforeFxUsdBalance);
  });

  it('supports a currency pair other than NGN/USD, as the integrator chooses', async () => {
    const ownerId = await givenCollectionWallet('10000', 'USD');
    const conversionId = randomUUID();

    const initiateRes = await initiate({
      conversionId, ownerId, fromCurrency: 'USD', toCurrency: 'GBP', fromAmount: '10000', rate: '1.25',
    });
    expect(initiateRes.status).toBe(201);
    expect(initiateRes.body.data.toAmount).toBe('8000'); // $100.00 at 1.25 USD/GBP -> £80.00
    expect(initiateRes.body.data.fromBalance.available).toBe('0');
    expect(initiateRes.body.data.toBalance.heldInflow).toBe('8000');

    const approveRes = await approve({ conversionId, ownerId, fromCurrency: 'USD', toCurrency: 'GBP' });
    expect(approveRes.status).toBe(201);
    expect(approveRes.body.data.toBalance.available).toBe('8000');
  });

  it('rejects converting a currency into itself', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const res = await initiate({
      conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'NGN', fromAmount: '150000', rate: '1',
    });

    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unregistered currency', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const res = await initiate({
      conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'ZZZ', fromAmount: '150000', rate: '1500',
    });

    expect(res.status).toBe(400);
    expect(res.body.data.code).toBe('INVALID_CURRENCY');
  });

  it('rejects initiating more than the wallet holds', async () => {
    const ownerId = await givenCollectionWallet('1000');
    const res = await initiate({
      conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '1001', rate: '1500',
    });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects initiating the same conversionId twice', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const conversionId = randomUUID();
    const body = { conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500' };

    const first = await initiate(body);
    expect(first.status).toBe(201);

    const second = await initiate(body);
    expect(second.status).toBe(409);
    expect(second.body.data.code).toBe('CONVERSION_ALREADY_INITIATED');
  });

  it('rejects approving a conversion that was never initiated', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const res = await approve({ conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });

    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe('CONVERSION_NOT_INITIATED');
  });

  it('rejects resolving a conversion twice', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const conversionId = randomUUID();

    await initiate({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500' });
    await approve({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });
    const res = await reject({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });

    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('CONVERSION_ALREADY_RESOLVED');
  });

  it('replays the stored result for a repeated idempotency key without moving money again', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const conversionId = randomUUID();
    const key = randomUUID();
    const body = { conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500' };

    const first = await initiate(body, key);
    const second = await initiate(body, key);

    expect(second.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);
  });

  it('lists only unresolved conversions with their currency pair, rate and amounts', async () => {
    const ownerId = await givenCollectionWallet('500000');
    const pendingId = randomUUID();
    const resolvedId = randomUUID();
    const body = (conversionId: string) => ({
      conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
    });

    await initiate(body(pendingId));
    await initiate(body(resolvedId));
    await approve({ conversionId: resolvedId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD' });

    const res = await get('/conversions/pending');

    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { conversionId: string }) => c.conversionId);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(resolvedId);
    const pending = res.body.data.find((c: { conversionId: string }) => c.conversionId === pendingId);
    expect(pending).toMatchObject({
      ownerId, fromCurrency: 'NGN', toCurrency: 'USD', rate: '1500', fromAmount: '150000', toAmount: '100',
    });
  });

  describe('wallet type', () => {
    it('defaults to the collection wallet when walletType is omitted', async () => {
      const ownerId = await givenCollectionWallet('500000');
      const res = await initiate({
        conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.walletType).toBe('collection');
    });

    it('holds and releases funds in the payout wallet, leaving the collection wallet untouched', async () => {
      const ownerId = await givenPayoutWallet('500000');
      const conversionId = randomUUID();

      const initiateRes = await initiate({
        conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
        walletType: 'payout',
      });
      expect(initiateRes.status).toBe(201);
      expect(initiateRes.body.data.walletType).toBe('payout');
      expect(initiateRes.body.data.fromBalance.available).toBe('350000');
      expect(initiateRes.body.data.fromBalance.heldInflow).toBe('150000');
      expect(initiateRes.body.data.toBalance.heldInflow).toBe('100');

      const collectionBalance = await get(`/wallets/${ownerId}/balance/NGN`);
      const collectionWallet = collectionBalance.body.data.find(
        (w: { walletType: string }) => w.walletType === 'collection',
      );
      expect(collectionWallet.available).toBe('0');

      const approveRes = await approve({
        conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', walletType: 'payout',
      });
      expect(approveRes.status).toBe(201);
      expect(approveRes.body.data.walletType).toBe('payout');
      expect(approveRes.body.data.toBalance.available).toBe('100');
    });

    it('reject fully reverses a payout-wallet conversion', async () => {
      const ownerId = await givenPayoutWallet('500000');
      const conversionId = randomUUID();

      await initiate({
        conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
        walletType: 'payout',
      });
      const res = await reject({ conversionId, ownerId, fromCurrency: 'NGN', toCurrency: 'USD', walletType: 'payout' });

      expect(res.status).toBe(201);
      expect(res.body.data.fromBalance.available).toBe('500000');
      expect(res.body.data.toBalance.available).toBe('0');
    });

    it('rejects initiating more than the payout wallet holds', async () => {
      const ownerId = await givenPayoutWallet('1000');
      const res = await initiate({
        conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '1001', rate: '1500',
        walletType: 'payout',
      });

      expect(res.status).toBe(422);
      expect(res.body.data.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('keeps a collection-wallet conversion and a payout-wallet conversion for the same owner/currency independent', async () => {
      const ownerId = await givenCollectionWallet('500000');
      await post('/wallets/transfer', {
        transferId: randomUUID(), ownerId, currency: 'NGN', amount: '200000', from: 'collection', to: 'payout',
      });

      const collectionRes = await initiate({
        conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
        walletType: 'collection',
      });
      const payoutRes = await initiate({
        conversionId: randomUUID(), ownerId, fromCurrency: 'NGN', toCurrency: 'USD', fromAmount: '150000', rate: '1500',
        walletType: 'payout',
      });

      expect(collectionRes.status).toBe(201);
      expect(payoutRes.status).toBe(201);
      expect(collectionRes.body.data.fromBalance.available).toBe('150000');
      expect(payoutRes.body.data.fromBalance.available).toBe('50000');
    });
  });
});
