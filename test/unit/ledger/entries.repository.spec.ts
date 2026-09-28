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
