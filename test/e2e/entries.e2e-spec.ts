import { randomUUID } from "crypto";
import request from 'supertest';
import { Types } from "mongoose";
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

describe('Entry lookup', () => {
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

  function get(path: string, query: Record<string, string> = {}, tenantId?: string) {
    const req = request(ctx.app.getHttpServer()).get(path).query(query).set('x-api-key', TEST_API_KEY);
    return tenantId ? req.set('x-tenant-id', tenantId) : req;
  }

  describe('GET /entries/:entryId', () => {
    it('returns the entry with its postings, stamped balanceAfter and sequence', async () => {
      const ownerId = randomUUID();
      const collectionId = randomUUID();
      const collected = await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount: '1500' });
      expect(collected.status).toBe(201);

      const res = await get(`/entries/${collected.body.data.entryId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        entryId: collected.body.data.entryId,
        operationId: collected.body.data.operationId,
        operationType: 'collection.receive',
        reference: collectionId,
        currency: 'NGN',
        reversalOf: null,
      });
      expect(res.body.data.postings).toEqual([
        expect.objectContaining({ kind: 'system', direction: 'debit', amount: '1500', balanceAfter: null, sequence: null }),
        expect.objectContaining({
          kind: 'user', ownerId, walletType: 'collection', accountType: 'held-inflow',
          direction: 'credit', amount: '1500', balanceAfter: '1500', sequence: 1,
        }),
      ]);
    });

    it.each([
      ['a malformed id', 'not-an-id'],
      ['an unknown id', new Types.ObjectId().toHexString()],
    ])('404s %s with a stable code', async (_label, id) => {
      const res = await get(`/entries/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.data.code).toBe('NOT_FOUND');
    });

    it("404s another tenant's entry", async () => {
      const collected = await post('/collections/collect', {
        collectionId: randomUUID(), ownerId: randomUUID(), currency: 'NGN', amount: '10',
      });
      const res = await get(`/entries/${collected.body.data.entryId}`, {}, 'some-other-tenant');
      expect(res.status).toBe(404);
      expect(res.body.data.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /entries?idempotencyKey=', () => {
    it('returns every entry a batch operation wrote, in order', async () => {
      const ownerId = randomUUID();
      const collectionIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const collectionId of collectionIds) {
        await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount: '100' });
      }
      const key = randomUUID();
      const batch = await post('/collections/settle-batch', {
        ownerId, currency: 'NGN', items: collectionIds.map((collectionId) => ({ collectionId, amount: '100' })),
      }, key);
      expect(batch.status).toBe(201);

      const res = await get('/entries', { idempotencyKey: key });

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((e: any) => e.reference)).toEqual(collectionIds);
      expect(res.body.data.items.map((e: any) => e.entryId)).toEqual(batch.body.data.items.map((i: any) => i.entryId));
      expect(res.body.data.items.every((e: any) => e.operationId === batch.body.data.operationId)).toBe(true);
    });

    it('returns an empty list for a key that was never used', async () => {
      const res = await get('/entries', { idempotencyKey: randomUUID() });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ items: [] });
    });

    it('returns an empty list for a request that was rejected', async () => {
      const key = randomUUID();
      const rejected = await post('/collections/settle', {
        collectionId: randomUUID(), ownerId: randomUUID(), currency: 'NGN', amount: '100',
      }, key);
      expect(rejected.status).toBe(422);

      const res = await get('/entries', { idempotencyKey: key });
      expect(res.body.data).toEqual({ items: [] });
    });

    it('still resolves a record written before operationId was stamped', async () => {
      const key = randomUUID();
      const collected = await post('/collections/collect', {
        collectionId: randomUUID(), ownerId: randomUUID(), currency: 'NGN', amount: '10',
      }, key);
      await ctx.db.collection('idempotency').updateOne({ key }, { $set: { operationId: null } });

      const res = await get('/entries', { idempotencyKey: key });

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].entryId).toBe(collected.body.data.entryId);
    });

    it("does not resolve another tenant's key", async () => {
      const key = randomUUID();
      await post('/collections/collect', { collectionId: randomUUID(), ownerId: randomUUID(), currency: 'NGN', amount: '10' }, key);
      const res = await get('/entries', { idempotencyKey: key }, 'some-other-tenant');
      expect(res.body.data).toEqual({ items: [] });
    });
  });

  describe('GET /entries?<reference>=', () => {
    it("returns a collection's lifecycle in order", async () => {
      const ownerId = randomUUID();
      const collectionId = randomUUID();
      await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount: '700' });
      await post('/collections/settle', { collectionId, ownerId, currency: 'NGN', amount: '700' });

      const res = await get('/entries', { collectionId });

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((e: any) => e.operationType)).toEqual(['collection.receive', 'collection.settle']);
    });

    it("returns a payout's lifecycle and ignores a collection sharing the same id", async () => {
      const ownerId = randomUUID();
      const sharedId = randomUUID();
      // The same string is used as both a collectionId and a payoutId.
      await post('/collections/collect', { collectionId: sharedId, ownerId, currency: 'NGN', amount: '1000' });
      await post('/collections/settle', { collectionId: sharedId, ownerId, currency: 'NGN', amount: '1000' });
      await post('/wallets/transfer', {
        transferId: randomUUID(), ownerId, currency: 'NGN', amount: '1000', from: 'collection', to: 'payout',
      });
      const payout = { payoutId: sharedId, ownerId, currency: 'NGN', amount: '400' };
      expect((await post('/payouts/status', { ...payout, status: 'initiated' })).status).toBe(201);
      expect((await post('/payouts/status', { ...payout, status: 'success' })).status).toBe(201);

      const payouts = await get('/entries', { payoutId: sharedId });
      expect(payouts.body.data.items.map((e: any) => e.operationType)).toEqual(['payout.initiate', 'payout.success']);

      const collections = await get('/entries', { collectionId: sharedId });
      expect(collections.body.data.items.map((e: any) => e.operationType)).toEqual([
        'collection.receive',
        'collection.settle',
      ]);
    });

    it('finds a wallet transfer by its transfer id', async () => {
      const ownerId = randomUUID();
      const collectionId = randomUUID();
      await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount: '50' });
      await post('/collections/settle', { collectionId, ownerId, currency: 'NGN', amount: '50' });
      const transferId = randomUUID();
      const transfer = await post('/wallets/transfer', {
        transferId, ownerId, currency: 'NGN', amount: '50', from: 'collection', to: 'payout',
      });

      const res = await get('/entries', { IntraTransferId: transferId });

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].entryId).toBe(transfer.body.data.entryId);
      expect(res.body.data.items[0].postings.map((p: any) => `${p.walletType}:${p.direction}`)).toEqual([
        'collection:debit',
        'payout:credit',
      ]);
    });

    it('returns an empty list for an unknown reference', async () => {
      const res = await get('/entries', { settlementId: randomUUID() });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ items: [] });
    });
  });

  describe('validation', () => {
    it.each([
      ['no key', {}],
      ['two keys', { collectionId: 'a', payoutId: 'b' }],
      ['an unsupported key', { reference: 'a' }],
    ])('rejects %s', async (_label, query) => {
      const res = await get('/entries', query as Record<string, string>);
      expect(res.status).toBe(400);
      expect(res.body.data.code).toBe('VALIDATION_FAILED');
    });
  });
});
