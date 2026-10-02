import { Types } from 'mongoose';
import { entryLookupSchema, entryView, REFERENCE_OPERATION_TYPES } from '../../../src/entries/dto';
import { EntryDoc, PostingDoc } from '../../../src/ledger/types';
import { TENANT } from '../../mocks';

describe('REFERENCE_OPERATION_TYPES', () => {
  it('maps each external reference to the operation types that stamp it', () => {
    expect(REFERENCE_OPERATION_TYPES).toEqual({
      collectionId: ['collection.receive', 'collection.settle', 'collection.settle.batch'],
      payoutId: ['payout.initiate', 'payout.success', 'payout.failed', 'payout.reverse', 'payout.reverse-failed'],
      settlementId: ['settlement.initiate', 'settlement.success', 'settlement.failed'],
      conversionId: ['conversion.initiate', 'conversion.approve', 'conversion.reject'],
      IntraTransferId: ['wallet.intra-transfer'],
    });
  });
});

describe('entryLookupSchema', () => {
  it.each([
    ['idempotencyKey', 'key-1'],
    ['collectionId', 'col-1'],
    ['payoutId', 'po-1'],
    ['settlementId', 'st-1'],
    ['conversionId', 'cv-1'],
    ['IntraTransferId', 'tr-1'],
  ])('accepts %s alone', (by, value) => {
    expect(entryLookupSchema.parse({ [by]: value })).toEqual({ by, value });
  });

  it('rejects no key at all', () => {
    const result = entryLookupSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/exactly one of/);
    expect(result.error?.issues[0].path).toEqual([]);
  });

  it('rejects more than one key, pointing at the extra one', () => {
    const result = entryLookupSchema.safeParse({ collectionId: 'col-1', payoutId: 'po-1' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['payoutId']);
  });

  it('rejects an empty value', () => {
    expect(entryLookupSchema.safeParse({ payoutId: '' }).success).toBe(false);
  });
});

describe('entryView', () => {
  it('renders ids as hex, amounts as strings and keeps system postings unstamped', () => {
    const reversalOf = new Types.ObjectId();
    const entry: EntryDoc = {
      _id: new Types.ObjectId(),
      tenantId: TENANT,
      operationId: new Types.ObjectId(),
      currency: 'NGN',
      operationType: 'payout.reverse',
      postingIds: [],
      reference: 'po-1',
      actor: 'ops@x',
      reversalOf,
      metadata: { note: 1 },
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    const user: PostingDoc = {
      _id: new Types.ObjectId(),
      tenantId: TENANT,
      operationId: entry.operationId,
      entryId: entry._id,
      accountId: new Types.ObjectId(),
      ownerId: 'm1',
      walletType: 'payout',
      accountType: 'available',
      kind: 'user',
      currency: 'NGN',
      direction: 'credit',
      amount: Types.Decimal128.fromString('250'),
      balanceAfter: Types.Decimal128.fromString('1250'),
      sequence: 4,
      operationType: 'payout.reverse',
      reference: 'po-1',
      actor: null,
      createdAt: entry.createdAt,
    };
    const system: PostingDoc = {
      ...user,
      _id: new Types.ObjectId(),
      ownerId: null,
      walletType: null,
      accountType: 'external:payout',
      kind: 'system',
      direction: 'debit',
      balanceAfter: null,
      sequence: null,
    };

    expect(entryView(entry, [system, user])).toEqual({
      entryId: entry._id.toHexString(),
      operationId: entry.operationId.toHexString(),
      operationType: 'payout.reverse',
      reference: 'po-1',
      currency: 'NGN',
      reversalOf: reversalOf.toHexString(),
      metadata: { note: 1 },
      actor: 'ops@x',
      createdAt: '2026-09-01T00:00:00.000Z',
      postings: [
        {
          postingId: system._id.toHexString(),
          kind: 'system',
          ownerId: null,
          walletType: null,
          accountType: 'external:payout',
          direction: 'debit',
          amount: '250',
          balanceAfter: null,
          sequence: null,
        },
        {
          postingId: user._id.toHexString(),
          kind: 'user',
          ownerId: 'm1',
          walletType: 'payout',
          accountType: 'available',
          direction: 'credit',
          amount: '250',
          balanceAfter: '1250',
          sequence: 4,
        },
      ],
    });
  });

  it('renders a missing reversal link as null', () => {
    const view = entryView(
      {
        _id: new Types.ObjectId(),
        tenantId: TENANT,
        operationId: new Types.ObjectId(),
        currency: 'NGN',
        operationType: 'wallet.intra-transfer',
        postingIds: [],
        reference: null,
        actor: null,
        reversalOf: null,
        metadata: null,
        createdAt: new Date(),
      },
      [],
    );
    expect(view.reversalOf).toBeNull();
    expect(view.postings).toEqual([]);
  });
});
