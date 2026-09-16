import { IdempotencyRepository } from '../../../src/ledger/idempotency.repository';
import { IdempotencyDoc } from '../../../src/ledger/types';
import { MockModel, TENANT, mockModel, mockQuery, mockSession } from '../../mocks';

const doc = (overrides: Partial<IdempotencyDoc> = {}): IdempotencyDoc => ({
  _id: `${TENANT}:key-1`,
  tenantId: TENANT,
  key: 'key-1',
  requestHash: 'hash',
  operationType: 'collection.receive',
  status: 'completed',
  result: { ok: true },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('IdempotencyRepository', () => {
  let model: MockModel<IdempotencyDoc>;
  let repo: IdempotencyRepository;

  beforeEach(() => {
    model = mockModel<IdempotencyDoc>();
    repo = new IdempotencyRepository(model.asModel);
  });

  it('creates its collection on boot and tolerates it already existing', async () => {
    await repo.onModuleInit();
    expect(model.createCollection).toHaveBeenCalled();

    model.createCollection.mockRejectedValue(new Error('exists'));
    await expect(repo.onModuleInit()).resolves.toBeUndefined();
  });

  describe('id', () => {
    it('scopes the key to the tenant', () => {
      expect(IdempotencyRepository.id('t1', 'key-1')).toBe('t1:key-1');
    });

    it('lets two tenants reuse the same key', () => {
      expect(IdempotencyRepository.id('t1', 'k')).not.toBe(IdempotencyRepository.id('t2', 'k'));
    });
  });

  describe('hash', () => {
    it('is a stable sha256 hex digest', () => {
      const hash = IdempotencyRepository.hash('op', { a: 1 });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(IdempotencyRepository.hash('op', { a: 1 })).toBe(hash);
    });

    it('ignores key order, so a semantically equal payload hashes the same', () => {
      expect(IdempotencyRepository.hash('op', { a: 1, b: 2 })).toBe(
        IdempotencyRepository.hash('op', { b: 2, a: 1 }),
      );
    });

    it('sorts keys at every depth', () => {
      expect(IdempotencyRepository.hash('op', { outer: { a: 1, b: 2 } })).toBe(
        IdempotencyRepository.hash('op', { outer: { b: 2, a: 1 } }),
      );
    });

    it('keeps array order significant', () => {
      expect(IdempotencyRepository.hash('op', { items: [1, 2] })).not.toBe(
        IdempotencyRepository.hash('op', { items: [2, 1] }),
      );
    });

    it('separates the operation type from the payload, so the two cannot be confused', () => {
      expect(IdempotencyRepository.hash('a', 'b')).not.toBe(IdempotencyRepository.hash('ab', ''));
    });

    it('distinguishes different operation types for the same payload', () => {
      expect(IdempotencyRepository.hash('collection.receive', { a: 1 })).not.toBe(
        IdempotencyRepository.hash('collection.settle', { a: 1 }),
      );
    });

    it('distinguishes different payloads', () => {
      expect(IdempotencyRepository.hash('op', { amount: '100' })).not.toBe(
        IdempotencyRepository.hash('op', { amount: '101' }),
      );
    });

    it.each([
      ['null', null],
      ['a string', 'plain'],
      ['a number', 42],
      ['a boolean', true],
      ['an array', [1, 'two', { three: 3 }]],
      ['a nested structure', { items: [{ b: 1, a: 2 }], top: null }],
    ])('hashes %s without throwing', (_label, payload) => {
      expect(IdempotencyRepository.hash('op', payload)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('distinguishes null from the string "null"', () => {
      expect(IdempotencyRepository.hash('op', null)).not.toBe(IdempotencyRepository.hash('op', 'null'));
    });
  });

  describe('find', () => {
    it('looks the record up by tenant-scoped id', async () => {
      const record = doc();
      model.findOne.mockReturnValue(mockQuery(record));

      await expect(repo.find(TENANT, 'key-1')).resolves.toBe(record);
      expect(model.findOne).toHaveBeenCalledWith({ _id: `${TENANT}:key-1` });
    });

    it('resolves null when the key has never been used', async () => {
      await expect(repo.find(TENANT, 'key-1')).resolves.toBeNull();
    });
  });

  describe('insert', () => {
    it('creates the record inside the caller transaction', async () => {
      const session = mockSession();
      const record = doc();

      await repo.insert(record, session.asSession);

      expect(model.create).toHaveBeenCalledWith([record], { session: session.asSession });
    });

    it('lets a duplicate-key error surface so the ledger can replay the winner', async () => {
      model.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
      await expect(repo.insert(doc(), mockSession().asSession)).rejects.toMatchObject({ code: 11000 });
    });
  });
});
