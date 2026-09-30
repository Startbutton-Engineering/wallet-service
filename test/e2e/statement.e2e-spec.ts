import { randomUUID } from "crypto";
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";

interface Row {
  postingId: string;
  entryId: string;
  operationId: string;
  operationType: string;
  reference: string | null;
  walletType: 'collection' | 'payout';
  accountType: string;
  direction: 'debit' | 'credit';
  amount: string;
  balanceAfter: string;
  sequence: number;
  createdAt: string;
}

describe('Wallet statement', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close()
  })

  function post(path: string, body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer())
      .post(path)
      .set('x-api-key', TEST_API_KEY)
      .set('idempotency-key', randomUUID())
      .send(body);
  }

  function statement(ownerId: string, query: Record<string, string | number> = {}, currency = 'NGN') {
    return request(ctx.app.getHttpServer())
      .get(`/wallets/${ownerId}/${currency}/statement`)
      .query(query)
      .set('x-api-key', TEST_API_KEY);
  }

  /** Follows nextCursor to the end, returning every page's rows in order. */
  async function readAll(ownerId: string, query: Record<string, string | number>): Promise<{ rows: Row[]; pages: number }> {
    const rows: Row[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await statement(ownerId, { ...query, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      rows.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
      pages++;
    } while (cursor);
    return { rows, pages };
  }

  async function collectAndSettle(ownerId: string, amount: string): Promise<void> {
    const collectionId = randomUUID();
    expect((await post('/collections/collect', { collectionId, ownerId, currency: 'NGN', amount })).status).toBe(201);
    expect((await post('/collections/settle', { collectionId, ownerId, currency: 'NGN', amount })).status).toBe(201);
  }

  const SETTLES = 25;
  const single = { walletType: 'collection', accountType: 'available' };
  let ownerId: string;

  /** 25 collect+settle pairs (25 available + 50 held-inflow postings), then one transfer to the
   * payout wallet (one more available debit + a payout credit): 77 user postings in all. */
  beforeAll(async () => {
    ownerId = randomUUID();
    for (let i = 1; i <= SETTLES; i++) await collectAndSettle(ownerId, String(i * 100));
    const res = await post('/wallets/transfer', {
      transferId: randomUUID(), ownerId, currency: 'NGN', amount: '500', from: 'collection', to: 'payout',
    });
    expect(res.status).toBe(201);
  });

  describe('single account (walletType + accountType)', () => {
    it('pages through every posting exactly once, in strictly increasing sequence', async () => {
      const { rows, pages } = await readAll(ownerId, { ...single, limit: 7 });

      expect(rows).toHaveLength(SETTLES + 1);
      expect(pages).toBe(Math.ceil((SETTLES + 1) / 7));
      expect(new Set(rows.map((r) => r.postingId)).size).toBe(rows.length);
      expect(rows.map((r) => r.sequence)).toEqual(Array.from({ length: SETTLES + 1 }, (_, i) => i + 1));
      expect(rows.every((r) => r.walletType === 'collection' && r.accountType === 'available')).toBe(true);
    });

    it('carries a balanceAfter that is the running balance of the rows before it', async () => {
      const { rows } = await readAll(ownerId, { ...single, limit: 10 });

      let running = 0n;
      for (const row of rows) {
        running += row.direction === 'credit' ? BigInt(row.amount) : -BigInt(row.amount);
        expect(row.balanceAfter).toBe(running.toString());
      }
      // 100 + 200 + ... + 2500, less the 500 transferred out.
      expect(running).toBe(BigInt((SETTLES * (SETTLES + 1) / 2) * 100 - 500));
    });

    it('returns the page size asked for and a null cursor on the last page', async () => {
      const first = await statement(ownerId, { ...single, limit: 26 });
      expect(first.body.data.items).toHaveLength(26);
      expect(first.body.data.nextCursor).toBeNull();
    });

    it('restricts to a from/to window', async () => {
      const { rows: all } = await readAll(ownerId, { ...single, limit: 200 });
      const from = all[9].createdAt;
      const to = all[14].createdAt;

      const { rows } = await readAll(ownerId, { ...single, from, to, limit: 4 });

      expect(rows.map((r) => r.sequence)).toEqual([10, 11, 12, 13, 14, 15]);
    });

    it('returns an empty page for a window with no postings', async () => {
      const res = await statement(ownerId, { ...single, from: '2000-01-01', to: '2000-01-02' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('merged sub-accounts', () => {
    it('covers every sub-account and wallet type, ordered by (createdAt, _id)', async () => {
      const { rows } = await readAll(ownerId, { limit: 9 });

      expect(rows).toHaveLength(SETTLES * 3 + 2);
      expect(new Set(rows.map((r) => r.postingId)).size).toBe(rows.length);
      expect(new Set(rows.map((r) => `${r.walletType}/${r.accountType}`))).toEqual(
        new Set(['collection/held-inflow', 'collection/available', 'payout/available']),
      );
      for (let i = 1; i < rows.length; i++) {
        const [a, b] = [rows[i - 1], rows[i]];
        const ordered = a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.postingId < b.postingId);
        expect(ordered).toBe(true);
      }
    });

    it('narrows to one wallet type and still shows it on every row', async () => {
      const { rows } = await readAll(ownerId, { walletType: 'payout', limit: 5 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ walletType: 'payout', accountType: 'available', amount: '500', balanceAfter: '500' });
    });

    it('narrows to one account type across wallet types', async () => {
      const { rows } = await readAll(ownerId, { accountType: 'available', limit: 8 });
      expect(rows).toHaveLength(SETTLES + 2);
    });
  });

  it('does not shift or repeat earlier rows when postings land between page fetches', async () => {
    const owner = randomUUID();
    for (let i = 0; i < 4; i++) await collectAndSettle(owner, '10');

    const first = await statement(owner, { ...single, limit: 2 });
    const seen: Row[] = [...first.body.data.items];

    // A new posting lands mid-pagination.
    await collectAndSettle(owner, '10');

    let cursor = first.body.data.nextCursor;
    while (cursor) {
      const res = await statement(owner, { ...single, limit: 2, cursor });
      seen.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
    }

    expect(seen.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seen.map((r) => r.postingId)).size).toBe(5);
  });

  describe('validation', () => {
    it('rejects a malformed cursor', async () => {
      const res = await statement(ownerId, { ...single, cursor: 'garbage' });
      expect(res.status).toBe(400);
      expect(res.body.data.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a cursor replayed against different filters', async () => {
      const page = await statement(ownerId, { ...single, limit: 1 });
      const res = await statement(ownerId, { limit: 1, cursor: page.body.data.nextCursor });
      expect(res.status).toBe(400);
      expect(res.body.data.code).toBe('VALIDATION_FAILED');
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 201 }],
      [{ walletType: 'savings' }],
      [{ from: '2026-09-02', to: '2026-09-01' }],
    ])('rejects the query %j', async (query) => {
      const res = await statement(ownerId, query as Record<string, string | number>);
      expect(res.status).toBe(400);
      expect(res.body.data.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown currency', async () => {
      const res = await statement(ownerId, {}, 'XXX');
      expect(res.status).toBe(400);
      expect(res.body.data.code).toBe('INVALID_CURRENCY');
    });
  });

  describe('not found', () => {
    it('404s an owner with no wallet in the currency', async () => {
      const res = await statement(randomUUID());
      expect(res.status).toBe(404);
      expect(res.body.data.code).toBe('NOT_FOUND');
    });

    it('404s a wallet type the owner was never provisioned for', async () => {
      const owner = randomUUID();
      await collectAndSettle(owner, '10');
      const res = await statement(owner, { walletType: 'payout' });
      expect(res.status).toBe(404);
      expect(res.body.data).toMatchObject({ code: 'NOT_FOUND', details: { walletType: 'payout' } });
    });

    it("404s another tenant's owner", async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/wallets/${ownerId}/NGN/statement`)
        .set('x-api-key', TEST_API_KEY)
        .set('x-tenant-id', 'some-other-tenant');
      expect(res.status).toBe(404);
      expect(res.body.data.code).toBe('NOT_FOUND');
    });
  });
});
