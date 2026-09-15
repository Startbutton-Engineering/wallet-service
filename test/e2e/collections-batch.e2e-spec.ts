import { randomUUID } from "crypto";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import request from 'supertest';
import { AccountDoc, userAccountId } from "../../src/accounts/account";
import { toDecimal128 } from "../../src/common/money";

describe('Collections batch settlement', () => {
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

  function settleBatch(body: Record<string, unknown>, idempotencyKey = randomUUID()) {
    return request(ctx.app.getHttpServer())
      .post('/collections/settle-batch')
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  }

  it('settles several collectionIds for the same owner in one call', async () => {
    const ownerId = randomUUID();
    const currency = 'NGN';
    const collectionIds = [randomUUID(), randomUUID(), randomUUID()];
    const amounts = ['1000', '2000', '3000'];

    for (let i = 0; i < collectionIds.length; i++) {
      const res = await collect({ collectionId: collectionIds[i], ownerId, currency, amount: amounts[i] });
      expect(res.status).toBe(201);
    }

    const res = await settleBatch({
      ownerId,
      currency,
      items: collectionIds.map((collectionId, i) => ({ collectionId, amount: amounts[i] })),
    });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(3);
    for (let i = 0; i < collectionIds.length; i++) {
      expect(res.body.items[i].collectionId).toBe(collectionIds[i]);
      expect(res.body.items[i].amountToCredit).toBe(amounts[i]);
      expect(typeof res.body.items[i].entryId).toBe('string');
      expect(res.body.items[i].entryId.length).toBeGreaterThan(0);
    }
    expect(res.body.balance.available).toBe('6000');
    expect(res.body.balance.heldInflow).toBe('0');

    // Each collectionId is independently settled - a later settle attempt against just one of
    // them (on its own) reports it as already fully settled, proving it got its own reference.
    const followUp = await settle({ collectionId: collectionIds[0], ownerId, currency, amount: '1' });
    expect(followUp.status).toBe(422);
    expect(followUp.body.code).toBe('COLLECTION_OVER_SETTLEMENT');
  });

  it('rejects the whole batch and posts nothing when one item is over-settlement, even if the others are valid', async () => {
    const ownerId = randomUUID();
    const currency = 'NGN';
    const goodId = randomUUID();
    const badId = randomUUID();

    await collect({ collectionId: goodId, ownerId, currency, amount: '1000' });
    await collect({ collectionId: badId, ownerId, currency, amount: '500' });

    const res = await settleBatch({
      ownerId,
      currency,
      items: [
        { collectionId: goodId, amount: '1000' },
        { collectionId: badId, amount: '9999' }, // more than collected for badId
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COLLECTION_OVER_SETTLEMENT');
    expect(res.body.details.collectionId).toBe(badId);

    // Nothing posted for the valid item either - the batch is atomic. (goodId already has its
    // two 'collection.receive' postings from the collect() call above - only settle postings matter here.)
    const postings = await ctx.db.collection('postings')
      .find({ reference: goodId, operationType: 'collection.settle.batch' })
      .toArray();
    expect(postings).toHaveLength(0);

    // goodId's held-inflow is still fully outstanding, unaffected by the aborted batch.
    const followUp = await settle({ collectionId: goodId, ownerId, currency, amount: '1000' });
    expect(followUp.status).toBe(201);
  });

  it('rejects a batch with a duplicate collectionId', async () => {
    const ownerId = randomUUID();
    const currency = 'NGN';
    const collectionId = randomUUID();
    await collect({ collectionId, ownerId, currency, amount: '1000' });

    const res = await settleBatch({
      ownerId,
      currency,
      items: [
        { collectionId, amount: '500' },
        { collectionId, amount: '500' },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('pays down refund/chargeback debt in array order before crediting available', async () => {
    const ownerId = randomUUID();
    const currency = 'NGN';
    const ids = [randomUUID(), randomUUID()];

    for (const collectionId of ids) {
      const res = await collect({ collectionId, ownerId, currency, amount: '1000' });
      expect(res.status).toBe(201);
    }

    // Seed a refund/chargeback debt (this service has no refunds endpoint yet - the debt account
    // is provisioned as a side effect of collect's ensureUserWallet, so it's safe to write to
    // directly here). Debt (700) is bigger than the first item alone but smaller than the batch.
    const refundChargebackAccountId = userAccountId('', ownerId, currency, 'refund-chargeback');
    const setResult = await ctx.db.collection<AccountDoc>('accounts').updateOne(
      { _id: refundChargebackAccountId },
      { $set: { balance: toDecimal128(-700n) } },
    );
    expect(setResult.matchedCount).toBe(1);

    const res = await settleBatch({
      ownerId,
      currency,
      items: ids.map((collectionId) => ({ collectionId, amount: '1000' })),
    });

    expect(res.status).toBe(201);
    // First item pays down the full 700 debt, keeps 300; second item has no debt left, keeps all 1000.
    expect(res.body.items[0].settledToDebit).toBe('700');
    expect(res.body.items[0].amountToCredit).toBe('300');
    expect(res.body.items[1].settledToDebit).toBe('0');
    expect(res.body.items[1].amountToCredit).toBe('1000');
    expect(res.body.balance.refundChargeback).toBe('0');
    expect(res.body.balance.available).toBe('1300');
  });

  it('replays the same result for a repeated idempotency key', async () => {
    const ownerId = randomUUID();
    const currency = 'NGN';
    const collectionId = randomUUID();
    await collect({ collectionId, ownerId, currency, amount: '1000' });

    const idempotencyKey = randomUUID();
    const body = { ownerId, currency, items: [{ collectionId, amount: '1000' }] };

    const first = await settleBatch(body, idempotencyKey);
    expect(first.status).toBe(201);

    const second = await settleBatch(body, idempotencyKey);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const postings = await ctx.db.collection('postings')
      .find({ reference: collectionId, operationType: 'collection.settle.batch' })
      .toArray();
    // one debit (held-inflow) + one credit (available) for the single settle - not duplicated by the replay
    expect(postings).toHaveLength(2);
  });
})
