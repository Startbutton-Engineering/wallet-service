import { Schema } from 'mongoose';
import { Account, AccountSchema } from '../../../src/accounts/account.schema';
import { CurrencyModel, CurrencySchema } from '../../../src/currency/currency.schema';
import { Entry, EntrySchema } from '../../../src/ledger/schemas/entry.schema';
import { Idempotency, IdempotencySchema } from '../../../src/ledger/schemas/idempotency.schema';
import { Outbox, OutboxSchema } from '../../../src/ledger/schemas/outbox.schema';
import { Posting, PostingSchema } from '../../../src/ledger/schemas/posting.schema';

/** The index definitions a schema declares, as plain field-order objects. */
const indexes = (schema: Schema) => schema.indexes().map(([fields]) => fields);

/** The same, but keeping each index's options — which is where `unique` lives. */
const indexSpecs = (schema: Schema) =>
  schema.indexes().map(([fields, options]) => ({ fields, options }));

const paths = (schema: Schema) => Object.keys(schema.paths);

/** The default a @Prop declared for one path. Mongoose wraps an object default in a
 * factory so every document gets its own copy, so resolve that the way mongoose does. */
const defaultOf = (schema: Schema, path: string) => {
  const declared = schema.path(path).options.default;
  return typeof declared === 'function' ? declared() : declared;
};

describe('mongo schemas', () => {
  it.each([
    ['Account', Account, AccountSchema, 'accounts'],
    ['CurrencyModel', CurrencyModel, CurrencySchema, 'currencies'],
    ['Entry', Entry, EntrySchema, 'entries'],
    ['Idempotency', Idempotency, IdempotencySchema, 'idempotency'],
    ['Outbox', Outbox, OutboxSchema, 'outbox'],
    ['Posting', Posting, PostingSchema, 'postings'],
  ] as [string, unknown, Schema, string][])(
    '%s maps to the %s collection with mongoose versioning off',
    (_name, _cls, schema, collection) => {
      expect(schema).toBeInstanceOf(Schema);
      expect(schema.get('collection')).toBe(collection);
      expect(schema.get('versionKey')).toBe(false);
    },
  );

  describe('AccountSchema', () => {
    it('declares an ObjectId _id, minted by the server rather than built in application code', () => {
      expect(AccountSchema.path('_id').instance).toBe('ObjectId');
    });

    it('holds the balance as Decimal128 and the OCC counter as a number', () => {
      expect(AccountSchema.path('balance').instance).toBe('Decimal128');
      expect(AccountSchema.path('version').instance).toBe('Number');
      expect(AccountSchema.path('sequence').instance).toBe('Number');
    });

    it('defaults ownerId and walletType to null, so a system account keeps its tuple', () => {
      // A 'collection' default here would be injected by setDefaultsOnInsert into a system
      // account's unique-index tuple and silently corrupt it.
      expect(defaultOf(AccountSchema, 'walletType')).toBeNull();
      expect(defaultOf(AccountSchema, 'ownerId')).toBeNull();
    });

    it('makes the identity tuple unique and keeps the system-account lookup', () => {
      const [identity, lookup] = indexSpecs(AccountSchema);
      expect(identity.fields).toEqual({
        tenantId: 1,
        ownerId: 1,
        currency: 1,
        walletType: 1,
        accountType: 1,
      });
      // Uniqueness of this tuple is what replaced the composite _id.
      expect(identity.options).toMatchObject({ unique: true });
      expect(lookup.fields).toEqual({ tenantId: 1, kind: 1, currency: 1 });
      expect(lookup.options?.unique).toBeUndefined();
    });
  });

  describe('PostingSchema', () => {
    it('keeps every field the posting document carries', () => {
      expect(paths(PostingSchema)).toEqual(
        expect.arrayContaining([
          '_id',
          'tenantId',
          'operationId',
          'entryId',
          'accountId',
          'ownerId',
          'walletType',
          'accountType',
          'kind',
          'currency',
          'direction',
          'amount',
          'balanceAfter',
          'sequence',
          'operationType',
          'reference',
          'actor',
          'createdAt',
        ]),
      );
    });

    it('carries the ids as ObjectIds and the denormalized ref type as strings', () => {
      for (const path of ['_id', 'operationId', 'entryId', 'accountId']) {
        expect(PostingSchema.path(path).instance).toBe('ObjectId');
      }
      expect(PostingSchema.path('accountType').instance).toBe('String');
      expect(PostingSchema.path('kind').instance).toBe('String');
    });

    it('holds amounts as Decimal128 and nulls the user-only fields by default', () => {
      expect(PostingSchema.path('amount').instance).toBe('Decimal128');
      expect(defaultOf(PostingSchema, 'balanceAfter')).toBeNull();
      expect(defaultOf(PostingSchema, 'sequence')).toBeNull();
      expect(defaultOf(PostingSchema, 'ownerId')).toBeNull();
      expect(defaultOf(PostingSchema, 'walletType')).toBeNull();
    });

    it('indexes the account statement, the operation and the reference lookups', () => {
      expect(indexes(PostingSchema)).toEqual([
        { accountId: 1, sequence: 1 },
        { operationId: 1 },
        // Serves referenceNetAmount; the old { tenantId, reference } index is its prefix.
        { tenantId: 1, reference: 1, accountType: 1, currency: 1, operationType: 1 },
      ]);
    });
  });

  describe('EntrySchema', () => {
    it('carries its ids and entry links as ObjectIds', () => {
      expect(EntrySchema.path('_id').instance).toBe('ObjectId');
      expect(EntrySchema.path('operationId').instance).toBe('ObjectId');
      expect(EntrySchema.path('reversalOf').instance).toBe('ObjectId');
      expect(EntrySchema.path('postingIds').instance).toBe('Array');
    });

    it('defaults postingIds to an empty list and the optional links to null', () => {
      expect(defaultOf(EntrySchema, 'postingIds')).toEqual([]);
      expect(defaultOf(EntrySchema, 'reference')).toBeNull();
      expect(defaultOf(EntrySchema, 'actor')).toBeNull();
      expect(defaultOf(EntrySchema, 'reversalOf')).toBeNull();
    });

    it('indexes by operation and by tenant-scoped reference', () => {
      expect(indexes(EntrySchema)).toEqual([{ operationId: 1 }, { tenantId: 1, reference: 1 }]);
    });
  });

  describe('IdempotencySchema', () => {
    it('keeps the stored result as mixed data, without minimising empty objects away', () => {
      expect(IdempotencySchema.path('result').instance).toBe('Mixed');
      expect(defaultOf(IdempotencySchema, 'result')).toBeNull();
      expect(IdempotencySchema.get('minimize')).toBe(false);
    });

    it('makes the tenant-scoped key unique, which is what the replay branch relies on', () => {
      expect(IdempotencySchema.path('_id').instance).toBe('ObjectId');
      const [key] = indexSpecs(IdempotencySchema);
      expect(key.fields).toEqual({ tenantId: 1, key: 1 });
      expect(key.options).toMatchObject({ unique: true });
    });
  });

  describe('OutboxSchema', () => {
    it('starts every event unpublished with a mixed payload', () => {
      expect(OutboxSchema.path('payload').instance).toBe('Mixed');
      expect(defaultOf(OutboxSchema, 'payload')).toEqual({});
      expect(defaultOf(OutboxSchema, 'publishedAt')).toBeNull();
      expect(OutboxSchema.get('minimize')).toBe(false);
    });

    it('indexes the publisher poll and makes dedupeId unique', () => {
      const [poll, dedupe] = indexSpecs(OutboxSchema);
      expect(poll.fields).toEqual({ published: 1, createdAt: 1 });
      expect(dedupe.fields).toEqual({ dedupeId: 1 });
      expect(dedupe.options).toMatchObject({ unique: true });
      expect(OutboxSchema.path('_id').instance).toBe('ObjectId');
      expect(OutboxSchema.path('operationId').instance).toBe('ObjectId');
      expect(OutboxSchema.path('dedupeId').instance).toBe('String');
    });
  });

  describe('CurrencySchema', () => {
    it('keys currencies uniquely by code', () => {
      expect(CurrencySchema.path('code').options.unique).toBe(true);
      expect(CurrencySchema.path('scale').instance).toBe('Number');
    });
  });
});
