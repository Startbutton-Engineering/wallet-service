import { Types } from 'mongoose';
import { PostingsRepository } from '../../../src/ledger/postings.repository';
import { PostingDoc } from '../../../src/ledger/types';
import { MockModel, TENANT, OWNER, CURRENCY, mockModel, mockQuery } from '../../mocks';

describe('PostingsRepository', () => {
  let model: MockModel<PostingDoc>;
  let repo: PostingsRepository;
  const accountId = new Types.ObjectId();
  const from = new Date('2026-09-01T00:00:00.000Z');
  const to = new Date('2026-09-30T00:00:00.000Z');

  beforeEach(() => {
    model = mockModel<PostingDoc>();
    repo = new PostingsRepository(model.asModel);
  });

  describe('sequenceBounds', () => {
    it('is an open range, with no queries, when neither bound is given', async () => {
      await expect(repo.sequenceBounds(accountId)).resolves.toEqual({});
      expect(model.findOne).not.toHaveBeenCalled();
    });

    it('seeks the first posting at or after `from` and the last at or before `to`', async () => {
      const first = mockQuery({ sequence: 4 });
      const last = mockQuery({ sequence: 9 });
      model.findOne.mockReturnValueOnce(first).mockReturnValueOnce(last);

      await expect(repo.sequenceBounds(accountId, from, to)).resolves.toEqual({ fromSeq: 4, toSeq: 9 });

      expect(model.findOne).toHaveBeenNthCalledWith(1, { accountId, createdAt: { $gte: from } });
      expect(first.sort).toHaveBeenCalledWith({ createdAt: 1, sequence: 1 });
      expect(model.findOne).toHaveBeenNthCalledWith(2, { accountId, createdAt: { $lte: to } });
      expect(last.sort).toHaveBeenCalledWith({ createdAt: -1, sequence: -1 });
    });

    it('returns null when nothing is at or after `from`', async () => {
      model.findOne.mockReturnValueOnce(mockQuery(null));
      await expect(repo.sequenceBounds(accountId, from)).resolves.toBeNull();
    });

    it('returns null when nothing is at or before `to`', async () => {
      model.findOne.mockReturnValueOnce(mockQuery(null));
      await expect(repo.sequenceBounds(accountId, undefined, to)).resolves.toBeNull();
    });

    it('returns null for an unstamped (system) posting', async () => {
      model.findOne.mockReturnValueOnce(mockQuery({ sequence: null }));
      await expect(repo.sequenceBounds(accountId, from)).resolves.toBeNull();
      model.findOne.mockReturnValueOnce(mockQuery({ sequence: null }));
      await expect(repo.sequenceBounds(accountId, undefined, to)).resolves.toBeNull();
    });

    it('returns null when the window falls between two postings', async () => {
      model.findOne.mockReturnValueOnce(mockQuery({ sequence: 5 })).mockReturnValueOnce(mockQuery({ sequence: 4 }));
      await expect(repo.sequenceBounds(accountId, from, to)).resolves.toBeNull();
    });
  });

  describe('pageByAccount', () => {
    it('pages in sequence order with no range when unbounded', async () => {
      const query = mockQuery([]);
      model.find.mockReturnValue(query);

      await repo.pageByAccount({ accountId, limit: 11 });

      expect(model.find).toHaveBeenCalledWith({ accountId });
      expect(query.sort).toHaveBeenCalledWith({ sequence: 1 });
      expect(query.limit).toHaveBeenCalledWith(11);
    });

    it('combines the window with the cursor', async () => {
      model.find.mockReturnValue(mockQuery([]));
      await repo.pageByAccount({ accountId, fromSeq: 3, toSeq: 90, afterSeq: 40, limit: 5 });
      expect(model.find).toHaveBeenCalledWith({ accountId, sequence: { $gte: 3, $lte: 90, $gt: 40 } });
    });
  });

  describe('pageByOwner', () => {
    const base = { tenantId: TENANT, ownerId: OWNER, currency: CURRENCY, limit: 51 };

    it("reads the owner's user postings in (createdAt, _id) order", async () => {
      const query = mockQuery([]);
      model.find.mockReturnValue(query);

      await repo.pageByOwner(base);

      expect(model.find).toHaveBeenCalledWith({ tenantId: TENANT, ownerId: OWNER, currency: CURRENCY, kind: 'user' });
      expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
      expect(query.limit).toHaveBeenCalledWith(51);
    });

    it('applies the sub-account filters, the window and the keyset cursor', async () => {
      model.find.mockReturnValue(mockQuery([]));
      const after = { createdAt: new Date('2026-09-10T00:00:00.000Z'), id: '64b7f0c2a1b2c3d4e5f60718' };

      await repo.pageByOwner({ ...base, walletType: 'payout', accountType: 'available', from, to, after });

      const [filter] = model.find.mock.calls[0] as any[];
      expect(filter).toMatchObject({
        walletType: 'payout',
        accountType: 'available',
        createdAt: { $gte: from, $lte: to },
      });
      expect(filter.$or).toEqual([
        { createdAt: { $gt: after.createdAt } },
        { createdAt: after.createdAt, _id: { $gt: new Types.ObjectId(after.id) } },
      ]);
    });

    it('accepts a half-open window', async () => {
      model.find.mockReturnValue(mockQuery([]));
      await repo.pageByOwner({ ...base, to });
      expect((model.find.mock.calls[0] as any[])[0].createdAt).toEqual({ $lte: to });
    });
  });

  describe('findByIds', () => {
    it('skips the query for no ids', async () => {
      await expect(repo.findByIds([])).resolves.toEqual([]);
      expect(model.find).not.toHaveBeenCalled();
    });

    it('loads the postings by _id', async () => {
      const ids = [new Types.ObjectId(), new Types.ObjectId()];
      model.find.mockReturnValue(mockQuery([{ _id: ids[0] }]));
      await expect(repo.findByIds(ids)).resolves.toEqual([{ _id: ids[0] }]);
      expect(model.find).toHaveBeenCalledWith({ _id: { $in: ids } });
    });
  });
});
