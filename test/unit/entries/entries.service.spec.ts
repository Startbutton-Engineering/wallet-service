import { Types } from 'mongoose';
import { EntriesService } from '../../../src/entries/entries.service';
import { REFERENCE_OPERATION_TYPES } from '../../../src/entries/dto';
import { EntriesRepository } from '../../../src/ledger/entries.repository';
import { PostingsRepository } from '../../../src/ledger/postings.repository';
import { IdempotencyRepository } from '../../../src/ledger/idempotency.repository';
import { EntryDoc, IdempotencyDoc, PostingDoc } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import { TENANT } from '../../mocks';

function posting(entryId: Types.ObjectId): PostingDoc {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    operationId: new Types.ObjectId(),
    entryId,
    accountId: new Types.ObjectId(),
    ownerId: 'm1',
    walletType: 'collection',
    accountType: 'available',
    kind: 'user',
    currency: 'NGN',
    direction: 'credit',
    amount: Types.Decimal128.fromString('10'),
    balanceAfter: Types.Decimal128.fromString('10'),
    sequence: 1,
    operationType: 'collection.settle',
    reference: 'col-1',
    actor: null,
    createdAt: new Date(),
  };
}

function entryWithPostings(count = 2): { entry: EntryDoc; postings: PostingDoc[] } {
  const _id = new Types.ObjectId();
  const postings = Array.from({ length: count }, () => posting(_id));
  return {
    entry: {
      _id,
      tenantId: TENANT,
      operationId: new Types.ObjectId(),
      currency: 'NGN',
      operationType: 'collection.settle',
      postingIds: postings.map((p) => p._id),
      reference: 'col-1',
      actor: null,
      reversalOf: null,
      metadata: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    postings,
  };
}

function idempotencyRecord(overrides: Partial<IdempotencyDoc> = {}): IdempotencyDoc {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    key: 'key-1',
    requestHash: 'h',
    operationType: 'collection.settle',
    status: 'completed',
    operationId: null,
    result: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('EntriesService', () => {
  let entries: { findById: jest.Mock; findByOperationId: jest.Mock; findByReference: jest.Mock };
  let postings: { findByIds: jest.Mock };
  let idempotency: { find: jest.Mock };
  let service: EntriesService;

  beforeEach(() => {
    entries = {
      findById: jest.fn(async () => null),
      findByOperationId: jest.fn(async () => []),
      findByReference: jest.fn(async () => []),
    };
    postings = { findByIds: jest.fn(async () => []) };
    idempotency = { find: jest.fn(async () => null) };
    service = new EntriesService(
      entries as unknown as EntriesRepository,
      postings as unknown as PostingsRepository,
      idempotency as unknown as IdempotencyRepository,
    );
  });

  describe('get', () => {
    it('returns the entry with its postings in the entry\'s own order', async () => {
      const { entry, postings: rows } = entryWithPostings(3);
      entries.findById.mockResolvedValue(entry);
      postings.findByIds.mockResolvedValue([rows[2], rows[0], rows[1]]);

      const view = await service.get(TENANT, entry._id.toHexString());

      expect(entries.findById).toHaveBeenCalledWith(TENANT, entry._id);
      expect(postings.findByIds).toHaveBeenCalledWith(entry.postingIds);
      expect(view.entryId).toBe(entry._id.toHexString());
      expect(view.postings.map((p) => p.postingId)).toEqual(rows.map((p) => p._id.toHexString()));
    });

    it('404s an unknown or other-tenant id', async () => {
      const id = new Types.ObjectId().toHexString();
      await expect(service.get(TENANT, id)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        httpStatus: 404,
        details: { entryId: id },
      });
    });

    it('404s a malformed id without querying', async () => {
      await expect(service.get(TENANT, 'not-an-id')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      await expect(service.get(TENANT, 'abcdefghijkl')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(entries.findById).not.toHaveBeenCalled();
    });
  });

  describe('lookup by idempotency key', () => {
    it('resolves the key to its operation and returns every entry it wrote', async () => {
      const a = entryWithPostings(1);
      const b = entryWithPostings(1);
      const operationId = new Types.ObjectId();
      idempotency.find.mockResolvedValue(idempotencyRecord({ operationId }));
      entries.findByOperationId.mockResolvedValue([a.entry, b.entry]);
      postings.findByIds.mockResolvedValue([...a.postings, ...b.postings]);

      const result = await service.lookup(TENANT, { by: 'idempotencyKey', value: 'key-1' });

      expect(idempotency.find).toHaveBeenCalledWith(TENANT, 'key-1');
      expect(entries.findByOperationId).toHaveBeenCalledWith(TENANT, operationId);
      expect(postings.findByIds).toHaveBeenCalledTimes(1);
      expect(result.items.map((e) => e.postings.length)).toEqual([1, 1]);
    });

    it('falls back to result.operationId on records written before the link existed', async () => {
      const operationId = new Types.ObjectId();
      idempotency.find.mockResolvedValue(idempotencyRecord({ result: { operationId: operationId.toHexString() } }));

      await service.lookup(TENANT, { by: 'idempotencyKey', value: 'key-1' });

      expect(entries.findByOperationId).toHaveBeenCalledWith(TENANT, operationId);
    });

    it('returns an empty list for an unknown key', async () => {
      await expect(service.lookup(TENANT, { by: 'idempotencyKey', value: 'nope' })).resolves.toEqual({ items: [] });
      expect(entries.findByOperationId).not.toHaveBeenCalled();
    });

    it.each([
      ['no result', null],
      ['a result without operationId', { ok: true }],
      ['a non-string operationId', { operationId: 42 }],
      ['a malformed operationId', { operationId: 'nope' }],
    ])('returns an empty list for a legacy record with %s', async (_label, result) => {
      idempotency.find.mockResolvedValue(idempotencyRecord({ result }));
      await expect(service.lookup(TENANT, { by: 'idempotencyKey', value: 'key-1' })).resolves.toEqual({ items: [] });
      expect(entries.findByOperationId).not.toHaveBeenCalled();
    });
  });

  describe('lookup by reference', () => {
    it.each(Object.keys(REFERENCE_OPERATION_TYPES))('restricts %s to its owning operation types', async (by) => {
      const { entry, postings: rows } = entryWithPostings();
      entries.findByReference.mockResolvedValue([entry]);
      postings.findByIds.mockResolvedValue(rows);

      const result = await service.lookup(TENANT, { by, value: 'ref-1' } as never);

      expect(entries.findByReference).toHaveBeenCalledWith(
        TENANT,
        'ref-1',
        REFERENCE_OPERATION_TYPES[by as keyof typeof REFERENCE_OPERATION_TYPES],
      );
      expect(result.items).toHaveLength(1);
    });

    it('returns an empty list when nothing was posted under the reference', async () => {
      await expect(service.lookup(TENANT, { by: 'payoutId', value: 'po-x' })).resolves.toEqual({ items: [] });
    });
  });
});
