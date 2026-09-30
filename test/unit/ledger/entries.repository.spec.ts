import { Types } from 'mongoose';
import { EntriesRepository } from '../../../src/ledger/entries.repository';
import { EntryDoc } from '../../../src/ledger/types';
import { mockModel, mockQuery } from '../../mocks';

const TENANT = 't1';
const INITIATE = 'conversion.initiate';
const RESOLVING = ['conversion.approve', 'conversion.reject'];

function entry(overrides: Partial<EntryDoc> = {}): EntryDoc {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    operationId: new Types.ObjectId(),
    currency: 'NGN',
    operationType: INITIATE,
    postingIds: [],
    reference: 'cv-1',
    actor: null,
    reversalOf: null,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EntriesRepository.findUnresolvedInitiations', () => {
  it('returns [] without a second query when there are no initiations', async () => {
    const model = mockModel<EntryDoc>();
    model.find.mockReturnValue(mockQuery([]));
    const repo = new EntriesRepository(model.asModel);

    const result = await repo.findUnresolvedInitiations(TENANT, INITIATE, RESOLVING);

    expect(result).toEqual([]);
    expect(model.find).toHaveBeenCalledTimes(1);
  });

  it('returns only references with no matching resolution entry', async () => {
    const model = mockModel<EntryDoc>();
    const initiated = [
      entry({ reference: 'cv-1' }),
      entry({ reference: 'cv-2' }),
    ];
    const resolved = [entry({ reference: 'cv-2', operationType: 'conversion.approve' })];
    model.find.mockReturnValueOnce(mockQuery(initiated)).mockReturnValueOnce(mockQuery(resolved));
    const repo = new EntriesRepository(model.asModel);

    const result = await repo.findUnresolvedInitiations(TENANT, INITIATE, RESOLVING);

    expect(result.map((e) => e.reference)).toEqual(['cv-1']);
  });

  it('dedupes to one entry per reference when both legs are initiate entries', async () => {
    const model = mockModel<EntryDoc>();
    const initiated = [
      entry({ reference: 'cv-1', currency: 'NGN' }),
      entry({ reference: 'cv-1', currency: 'USD' }),
    ];
    model.find.mockReturnValueOnce(mockQuery(initiated)).mockReturnValueOnce(mockQuery([]));
    const repo = new EntriesRepository(model.asModel);

    const result = await repo.findUnresolvedInitiations(TENANT, INITIATE, RESOLVING);

    expect(result).toHaveLength(1);
  });

  it('respects the limit', async () => {
    const model = mockModel<EntryDoc>();
    const initiated = [
      entry({ reference: 'cv-1' }),
      entry({ reference: 'cv-2' }),
      entry({ reference: 'cv-3' }),
    ];
    model.find.mockReturnValueOnce(mockQuery(initiated)).mockReturnValueOnce(mockQuery([]));
    const repo = new EntriesRepository(model.asModel);

    const result = await repo.findUnresolvedInitiations(TENANT, INITIATE, RESOLVING, { limit: 2 });

    expect(result).toHaveLength(2);
  });
});

describe('EntriesRepository lookups', () => {
  it('finds one entry by id within the tenant', async () => {
    const model = mockModel<EntryDoc>();
    const found = entry();
    model.findOne.mockReturnValue(mockQuery(found));
    const repo = new EntriesRepository(model.asModel);

    await expect(repo.findById(TENANT, found._id)).resolves.toBe(found);
    expect(model.findOne).toHaveBeenCalledWith({ _id: found._id, tenantId: TENANT });
  });

  it('finds every entry of one operation, oldest first', async () => {
    const model = mockModel<EntryDoc>();
    const query = mockQuery([entry()]);
    model.find.mockReturnValue(query);
    const repo = new EntriesRepository(model.asModel);
    const operationId = new Types.ObjectId();

    await expect(repo.findByOperationId(TENANT, operationId)).resolves.toHaveLength(1);
    expect(model.find).toHaveBeenCalledWith({ tenantId: TENANT, operationId });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
  });

  it("finds a reference's lifecycle restricted to the owning operation types", async () => {
    const model = mockModel<EntryDoc>();
    const query = mockQuery([]);
    model.find.mockReturnValue(query);
    const repo = new EntriesRepository(model.asModel);

    await repo.findByReference(TENANT, 'po-1', ['payout.initiate', 'payout.success']);
    expect(model.find).toHaveBeenCalledWith({
      tenantId: TENANT,
      reference: 'po-1',
      operationType: { $in: ['payout.initiate', 'payout.success'] },
    });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
  });
});
