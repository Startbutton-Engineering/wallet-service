import { collectionBatchSchema, collectionSchema } from '../../../src/collections/dto';

describe('collectionSchema', () => {
  const body = { collectionId: 'col-1', ownerId: 'm1', currency: 'NGN', amount: '1000' };

  it('accepts a well-formed collection', () => {
    expect(collectionSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['an empty collectionId', { collectionId: '' }],
    ['an empty ownerId', { ownerId: '' }],
    ['an empty currency', { currency: '' }],
    ['a zero amount', { amount: '0' }],
    ['a negative amount', { amount: '-1' }],
  ])('rejects %s', (_label, patch) => {
    expect(collectionSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});

describe('collectionBatchSchema', () => {
  const batch = (items: { collectionId: string; amount: string }[]) => ({
    ownerId: 'm1',
    currency: 'NGN',
    items,
  });

  it('accepts a batch of distinct collections', () => {
    const body = batch([
      { collectionId: 'col-1', amount: '100' },
      { collectionId: 'col-2', amount: '200' },
    ]);
    expect(collectionBatchSchema.parse(body)).toEqual(body);
  });

  it('accepts the smallest and largest allowed batch', () => {
    expect(collectionBatchSchema.safeParse(batch([{ collectionId: 'c', amount: '1' }])).success).toBe(true);

    const thousand = Array.from({ length: 1000 }, (_, i) => ({ collectionId: `c${i}`, amount: '1' }));
    expect(collectionBatchSchema.safeParse(batch(thousand)).success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(collectionBatchSchema.safeParse(batch([])).success).toBe(false);
  });

  it('rejects a batch of more than 1000 items', () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ collectionId: `c${i}`, amount: '1' }));
    expect(collectionBatchSchema.safeParse(batch(items)).success).toBe(false);
  });

  it('rejects a duplicated collectionId, since the two would settle against each other', () => {
    const result = collectionBatchSchema.safeParse(
      batch([
        { collectionId: 'col-1', amount: '100' },
        { collectionId: 'col-1', amount: '200' },
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('duplicate collectionId in batch');
  });

  it('rejects an item with a zero amount', () => {
    expect(collectionBatchSchema.safeParse(batch([{ collectionId: 'c', amount: '0' }])).success).toBe(false);
  });

  it('rejects an item with an empty collectionId', () => {
    expect(collectionBatchSchema.safeParse(batch([{ collectionId: '', amount: '1' }])).success).toBe(false);
  });
});
