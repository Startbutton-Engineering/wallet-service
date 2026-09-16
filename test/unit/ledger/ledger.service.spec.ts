import { Types } from 'mongoose';
import {
  LedgerOperation,
  LedgerService,
  PostArgs,
  PrePostContext,
} from '../../../src/ledger/ledger.service';
import { IdempotencyRepository } from '../../../src/ledger/idempotency.repository';
import { OutboxRepository } from '../../../src/ledger/outbox.repository';
import {
  AccountDoc,
  AccountRef,
  accountRef,
  System,
  systemAccountId,
  userAccountId,
} from '../../../src/accounts/account';
import { AppError, ErrorCode, OccConflict } from '../../../src/common/errors';
import { fromDecimal128, toDecimal128 } from '../../../src/common/money';
import { EntryDoc, PostingDoc } from '../../../src/ledger/types';
import {
  CURRENCY,
  OWNER,
  TENANT,
  accountDoc,
  mockAccountsRepository,
  mockModel,
  mockQuery,
  mockSession,
  mongoServerError,
  walletBalance,
} from '../../mocks';

const available = accountRef.collectionWallet(OWNER, CURRENCY, 'available');
const heldInflow = accountRef.collectionWallet(OWNER, CURRENCY, 'held-inflow');
const systemCollection = accountRef.systemCollection(CURRENCY);

const idOf = (ref: AccountRef): string =>
  ref.kind === 'user'
    ? userAccountId(TENANT, ref.ownerId, ref.currency, ref.walletType, ref.accountType)
    : systemAccountId(TENANT, ref.name, ref.currency);

/** Wires a LedgerService against mocked models plus an in-memory account store,
 * so a test seeds the accounts an operation touches and asserts on what was written. */
class LedgerTestBed {
  readonly postings = mockModel<PostingDoc>();
  readonly entries = mockModel<EntryDoc>();
  readonly session = mockSession();
  readonly accounts = mockModel<AccountDoc>(this.session);
  readonly accountsRepo = mockAccountsRepository(() => walletBalance());
  readonly idempotency = {
    find: jest.fn(async () => null as unknown),
    insert: jest.fn(async () => undefined),
  };
  readonly outbox = { write: jest.fn(async () => undefined) };
  readonly service: LedgerService;

  private readonly store = new Map<string, AccountDoc>();

  constructor() {
    this.accounts.find.mockImplementation((filter: any) =>
      mockQuery(
        (filter?._id?.$in ?? [])
          .map((id: string) => this.store.get(id))
          .filter((doc: AccountDoc | undefined): doc is AccountDoc => !!doc),
      ),
    );
    this.service = new LedgerService(
      this.postings.asModel,
      this.entries.asModel,
      this.accounts.asModel,
      this.idempotency as unknown as IdempotencyRepository,
      this.accountsRepo.asRepository,
      this.outbox as unknown as OutboxRepository,
    );
  }

  /** Register an account the operation under test will touch. */
  seed(ref: AccountRef, overrides: Partial<AccountDoc> = {}): this {
    const _id = idOf(ref);
    this.store.set(
      _id,
      accountDoc({
        _id,
        kind: ref.kind,
        ownerId: ref.kind === 'user' ? ref.ownerId : null,
        walletType: ref.kind === 'user' ? ref.walletType : null,
        accountType: ref.kind === 'user' ? ref.accountType : ref.name,
        currency: ref.currency,
        ...overrides,
      }),
    );
    return this;
  }

  doc(ref: AccountRef): AccountDoc {
    return this.store.get(idOf(ref))!;
  }

  /** Every posting handed to insertMany, flattened. */
  get writtenPostings(): PostingDoc[] {
    return this.postings.insertMany.mock.calls.flatMap(([docs]) => docs as PostingDoc[]);
  }

  get writtenEntries(): EntryDoc[] {
    return this.entries.insertMany.mock.calls.flatMap(([docs]) => docs as EntryDoc[]);
  }

  /** The update applied to one account, or undefined when it was never written. */
  updateFor(ref: AccountRef): { filter: any; update: any } | undefined {
    const call = this.accounts.updateOne.mock.calls.find(([filter]) => filter._id === idOf(ref));
    return call && { filter: call[0], update: call[1] };
  }
}

const operation = (overrides: Partial<LedgerOperation<any>> = {}): LedgerOperation<any> => ({
  entries: [],
  buildResponse: (post) => ({ operationId: post.operationId, entryIds: post.entryIds }),
  buildEvent: () => ({ type: 'TestEvent', payload: {} }),
  ...overrides,
});

const args = (
  overrides: Partial<PostArgs<any>> & Pick<PostArgs<any>, 'generateLedgerOps'>,
): PostArgs<any> => ({
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  operationType: 'test.op',
  requestPayload: { a: 1 },
  ...overrides,
});

const transfer = (amount: bigint) =>
  operation({
    entries: [
      {
        currency: CURRENCY,
        postings: [
          { account: systemCollection, direction: 'debit', amount },
          { account: heldInflow, direction: 'credit', amount },
        ],
      },
    ],
  });

describe('LedgerService', () => {
  let bed: LedgerTestBed;

  beforeEach(() => {
    bed = new LedgerTestBed();
    bed.seed(systemCollection, { kind: 'system' }).seed(heldInflow).seed(available);
  });

  describe('onModuleInit', () => {
    it('creates the postings and entries collections', async () => {
      await bed.service.onModuleInit();
      expect(bed.postings.createCollection).toHaveBeenCalled();
      expect(bed.entries.createCollection).toHaveBeenCalled();
    });

    it('tolerates the collections already existing', async () => {
      bed.postings.createCollection.mockRejectedValue(new Error('exists'));
      bed.entries.createCollection.mockRejectedValue(new Error('exists'));
      await expect(bed.service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('idempotent replay', () => {
    it('returns the stored result without opening a transaction', async () => {
      const hash = IdempotencyRepository.hash('test.op', { a: 1 });
      bed.idempotency.find.mockResolvedValue({ requestHash: hash, result: { replayed: true } });
      const generateLedgerOps = jest.fn();

      await expect(bed.service.post(args({ generateLedgerOps }))).resolves.toEqual({ replayed: true });
      expect(generateLedgerOps).not.toHaveBeenCalled();
      expect(bed.accounts.db.startSession).not.toHaveBeenCalled();
    });

    it('rejects the same key reused for a different payload', async () => {
      bed.idempotency.find.mockResolvedValue({ requestHash: 'some-other-hash', result: {} });

      await expect(
        bed.service.post(args({ generateLedgerOps: async () => operation() })),
      ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSE, details: { idempotencyKey: 'key-1' } });
    });
  });

  describe('posting a balanced operation', () => {
    it('returns what buildResponse produced', async () => {
      await expect(
        bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) })),
      ).resolves.toEqual({ operationId: expect.any(String), entryIds: [expect.any(String)] });
    });

    it('writes one posting per leg, tagged with the operation and entry', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      const written = bed.writtenPostings;
      expect(written).toHaveLength(2);
      expect(written.map((p) => [p.accountId, p.direction, fromDecimal128(p.amount)])).toEqual([
        [idOf(systemCollection), 'debit', 1000n],
        [idOf(heldInflow), 'credit', 1000n],
      ]);
      expect(new Set(written.map((p) => p.operationId)).size).toBe(1);
      expect(new Set(written.map((p) => p.entryId)).size).toBe(1);
      expect(written[0].operationId).toBe(bed.writtenEntries[0].operationId);
    });

    it('records balanceAfter and a running sequence on user postings only', async () => {
      bed.seed(heldInflow, { balance: toDecimal128(400n), sequence: 7 });

      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      const [system, user] = bed.writtenPostings;
      expect(system.balanceAfter).toBeNull();
      expect(system.sequence).toBeNull();
      expect(system.ownerId).toBeNull();
      expect(system.walletType).toBeNull();
      expect(fromDecimal128(user.balanceAfter!)).toBe(1400n);
      expect(user.sequence).toBe(8);
      expect(user.ownerId).toBe(OWNER);
      expect(user.walletType).toBe('collection');
    });

    it('OCC-guards user account updates and bumps the version', async () => {
      bed.seed(heldInflow, { version: 3, balance: toDecimal128(400n), sequence: 1 });

      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      const update = bed.updateFor(heldInflow)!;
      expect(update.filter).toEqual({ _id: idOf(heldInflow), version: 3 });
      expect(fromDecimal128(update.update.$set.balance)).toBe(1400n);
      expect(update.update.$set.sequence).toBe(2);
      expect(update.update.$inc).toEqual({ version: 1 });
    });

    it('updates system accounts by id alone, with no version guard or sequence', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      const update = bed.updateFor(systemCollection)!;
      expect(update.filter).toEqual({ _id: idOf(systemCollection) });
      expect(update.update.$inc).toBeUndefined();
      expect(fromDecimal128(update.update.$set.balance)).toBe(-1000n);
      expect(update.update.$set.sequence).toBeUndefined();
    });

    it('nets several postings against one account into a single update', async () => {
      const multi = operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: systemCollection, direction: 'debit', amount: 300n },
              { account: heldInflow, direction: 'credit', amount: 100n },
              { account: heldInflow, direction: 'credit', amount: 200n },
            ],
          },
        ],
      });

      await bed.service.post(args({ generateLedgerOps: async () => multi }));

      const updates = bed.accounts.updateOne.mock.calls.filter(
        ([filter]) => filter._id === idOf(heldInflow),
      );
      expect(updates).toHaveLength(1);
      expect(fromDecimal128(updates[0][1].$set.balance)).toBe(300n);
      expect(updates[0][1].$set.sequence).toBe(2);
    });

    it('writes an entry citing its postings, reference and actor', async () => {
      await bed.service.post(
        args({
          generateLedgerOps: async () => transfer(1000n),
          reference: 'col-1',
          actor: 'ops@example.com',
        }),
      );

      const [entry] = bed.writtenEntries;
      expect(entry).toMatchObject({
        tenantId: TENANT,
        currency: CURRENCY,
        operationType: 'test.op',
        reference: 'col-1',
        actor: 'ops@example.com',
        reversalOf: null,
      });
      expect(entry.postingIds).toEqual(bed.writtenPostings.map((p) => p._id));
      expect(bed.writtenPostings.every((p) => p.reference === 'col-1')).toBe(true);
      expect(bed.writtenPostings.every((p) => p.actor === 'ops@example.com')).toBe(true);
    });

    it('defaults reference and actor to null', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      expect(bed.writtenEntries[0]).toMatchObject({ reference: null, actor: null });
      expect(bed.writtenPostings[0]).toMatchObject({ reference: null, actor: null });
    });

    it('lets an entry override the reference and operationType of the call', async () => {
      const overridden = operation({
        entries: [
          {
            currency: CURRENCY,
            reference: 'col-9',
            operationType: 'collection.settle',
            postings: [
              { account: systemCollection, direction: 'debit', amount: 10n },
              { account: heldInflow, direction: 'credit', amount: 10n },
            ],
          },
        ],
      });

      await bed.service.post(
        args({ generateLedgerOps: async () => overridden, reference: 'batch-1' }),
      );

      expect(bed.writtenEntries[0]).toMatchObject({
        reference: 'col-9',
        operationType: 'collection.settle',
      });
      expect(bed.writtenPostings.every((p) => p.reference === 'col-9')).toBe(true);
    });

    it('stamps reversalOf on every entry of the operation', async () => {
      const reversal = operation({ ...transfer(10n), reversalOf: 'entry-earlier' });

      await bed.service.post(args({ generateLedgerOps: async () => reversal }));

      expect(bed.writtenEntries[0].reversalOf).toBe('entry-earlier');
    });

    it('records the idempotency key with the response, inside the transaction', async () => {
      const result = await bed.service.post(
        args({ generateLedgerOps: async () => transfer(1000n), idempotencyKey: 'key-9' }),
      );

      const [record, session] = bed.idempotency.insert.mock.calls[0] as any[];
      expect(record).toMatchObject({
        _id: `${TENANT}:key-9`,
        tenantId: TENANT,
        key: 'key-9',
        operationType: 'test.op',
        status: 'completed',
        result,
      });
      expect(record.requestHash).toBe(IdempotencyRepository.hash('test.op', { a: 1 }));
      expect(session).toBe(bed.session);
    });

    it('writes the outbox event for the operation', async () => {
      await bed.service.post(
        args({
          generateLedgerOps: async () =>
            operation({ ...transfer(5n), buildEvent: () => ({ type: 'Only', payload: { x: 1 } }) }),
        }),
      );

      expect(bed.outbox.write).toHaveBeenCalledTimes(1);
      const [tenantId, operationId, event, session] = bed.outbox.write.mock.calls[0] as any[];
      expect(tenantId).toBe(TENANT);
      expect(operationId).toBe(bed.writtenEntries[0].operationId);
      expect(event).toEqual({ type: 'Only', payload: { x: 1 } });
      expect(session).toBe(bed.session);
    });

    it('writes every event when buildEvent returns several', async () => {
      await bed.service.post(
        args({
          generateLedgerOps: async () =>
            operation({
              ...transfer(5n),
              buildEvent: () => [
                { type: 'First', payload: {} },
                { type: 'Second', payload: {} },
              ],
            }),
        }),
      );

      expect(bed.outbox.write.mock.calls.map((c: any[]) => c[2].type)).toEqual(['First', 'Second']);
    });

    it('runs sideEffect before building the response', async () => {
      const order: string[] = [];
      await bed.service.post(
        args({
          generateLedgerOps: async () =>
            operation({
              ...transfer(5n),
              sideEffect: async () => {
                order.push('sideEffect');
              },
              buildResponse: () => {
                order.push('buildResponse');
                return {};
              },
            }),
        }),
      );

      expect(order).toEqual(['sideEffect', 'buildResponse']);
    });

    it('provisions the accounts each posting touches before loading them', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(1000n) }));

      expect(bed.accountsRepo.ensureUserWallet).toHaveBeenCalledWith(
        TENANT,
        OWNER,
        CURRENCY,
        'collection',
        bed.session,
      );
      expect(bed.accountsRepo.ensureSystem).toHaveBeenCalledWith(
        TENANT,
        System.collection,
        CURRENCY,
        bed.session,
      );
    });

    it('provisions each owner wallet once however many of its sub-accounts are touched', async () => {
      const wide = operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: heldInflow, direction: 'debit', amount: 10n },
              { account: available, direction: 'credit', amount: 10n },
            ],
          },
        ],
      });

      await bed.service.post(args({ generateLedgerOps: async () => wide }));

      expect(bed.accountsRepo.ensureUserWallet).toHaveBeenCalledTimes(1);
    });

    it('ends the session even on the happy path', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(1n) }));
      expect(bed.session.endSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation', () => {
    it('rejects an entry whose debits and credits do not match', async () => {
      const unbalanced = operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: systemCollection, direction: 'debit', amount: 100n },
              { account: heldInflow, direction: 'credit', amount: 90n },
            ],
          },
        ],
      });

      await expect(
        bed.service.post(args({ generateLedgerOps: async () => unbalanced })),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Entry is not balanced (debits must equal credits)',
        details: { currency: CURRENCY, net: '-10' },
      });
      expect(bed.postings.insertMany).not.toHaveBeenCalled();
    });

    it.each([
      ['zero', 0n],
      ['negative', -5n],
    ])('rejects a %s posting amount even when the entry nets to zero', async (_label, amount) => {
      const bad = operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: systemCollection, direction: 'debit', amount },
              { account: heldInflow, direction: 'credit', amount },
            ],
          },
        ],
      });

      await expect(bed.service.post(args({ generateLedgerOps: async () => bad }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Posting amounts must be positive',
      });
    });

    it('accepts an operation with no entries at all', async () => {
      await expect(bed.service.post(args({ generateLedgerOps: async () => operation() }))).resolves.toEqual(
        { operationId: expect.any(String), entryIds: [] },
      );
    });

    it('validates every entry, not only the first', async () => {
      const mixed = operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: systemCollection, direction: 'debit', amount: 10n },
              { account: heldInflow, direction: 'credit', amount: 10n },
            ],
          },
          {
            currency: CURRENCY,
            postings: [{ account: heldInflow, direction: 'credit', amount: 10n }],
          },
        ],
      });

      await expect(bed.service.post(args({ generateLedgerOps: async () => mixed }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
    });
  });

  describe('overdraft guard', () => {
    const drain = (amount: bigint) =>
      operation({
        entries: [
          {
            currency: CURRENCY,
            postings: [
              { account: available, direction: 'debit', amount },
              { account: systemCollection, direction: 'credit', amount },
            ],
          },
        ],
        guardNegative: [available],
      });

    it('rejects an operation that would take a guarded account below zero', async () => {
      bed.seed(available, { balance: toDecimal128(500n) });

      await expect(bed.service.post(args({ generateLedgerOps: async () => drain(600n) }))).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_FUNDS,
        details: {
          accountType: 'available',
          currency: CURRENCY,
          available: '500',
          availableAfter: '-100',
        },
      });
      expect(bed.postings.insertMany).not.toHaveBeenCalled();
    });

    it('allows an operation that lands exactly on zero', async () => {
      bed.seed(available, { balance: toDecimal128(500n) });
      await expect(bed.service.post(args({ generateLedgerOps: async () => drain(500n) }))).resolves.toBeDefined();
    });

    it('ignores a guarded account the operation never touched', async () => {
      const untouched = operation({ ...transfer(10n), guardNegative: [available] });
      await expect(bed.service.post(args({ generateLedgerOps: async () => untouched }))).resolves.toBeDefined();
    });

    it('leaves an unguarded account free to go negative', async () => {
      bed.seed(available, { balance: toDecimal128(0n) });
      const unguarded = operation({ ...drain(600n), guardNegative: [] });
      await expect(bed.service.post(args({ generateLedgerOps: async () => unguarded }))).resolves.toBeDefined();
    });
  });

  describe('concurrency', () => {
    it('retries when a user account lost the OCC race, then succeeds', async () => {
      let firstUserUpdate = true;
      bed.accounts.updateOne.mockImplementation(async (filter: any) => {
        if (filter.version !== undefined && firstUserUpdate) {
          firstUserUpdate = false;
          return { matchedCount: 0 };
        }
        return { matchedCount: 1 };
      });

      await expect(bed.service.post(args({ generateLedgerOps: async () => transfer(10n) }))).resolves.toBeDefined();
      expect(bed.session.abortTransaction).toHaveBeenCalledTimes(1);
      expect(bed.session.endSession).toHaveBeenCalledTimes(2);
    });

    it('gives up with a retryable error after eight OCC conflicts', async () => {
      bed.accounts.updateOne.mockImplementation(async (filter: any) => ({
        matchedCount: filter.version === undefined ? 1 : 0,
      }));

      await expect(bed.service.post(args({ generateLedgerOps: async () => transfer(10n) }))).rejects.toMatchObject({
        code: ErrorCode.CONCURRENCY_RETRY_EXHAUSTED,
        retryable: true,
      });
      expect(bed.session.endSession).toHaveBeenCalledTimes(8);
    });

    it('propagates an OccConflict thrown from inside the caller plan as a retry', async () => {
      const generateLedgerOps = jest
        .fn<Promise<LedgerOperation<any>>, [PrePostContext]>()
        .mockRejectedValueOnce(new OccConflict())
        .mockImplementation(async () => transfer(10n));

      await expect(bed.service.post(args({ generateLedgerOps }))).resolves.toBeDefined();
      expect(generateLedgerOps).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a TransientTransactionError', { labels: ['TransientTransactionError'] }],
      ['an UnknownTransactionCommitResult', { labels: ['UnknownTransactionCommitResult'] }],
      ['a WriteConflict', { codeName: 'WriteConflict' }],
    ])('retries %s from mongo', async (_label, options) => {
      const generateLedgerOps = jest
        .fn<Promise<LedgerOperation<any>>, [PrePostContext]>()
        .mockRejectedValueOnce(mongoServerError(options))
        .mockImplementation(async () => transfer(10n));

      await expect(bed.service.post(args({ generateLedgerOps }))).resolves.toBeDefined();
      expect(generateLedgerOps).toHaveBeenCalledTimes(2);
    });

    it('replays the winner when a concurrent request already claimed the key', async () => {
      const hash = IdempotencyRepository.hash('test.op', { a: 1 });
      bed.idempotency.find
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ requestHash: hash, result: { fromWinner: true } });
      bed.idempotency.insert.mockRejectedValue(mongoServerError({ code: 11000 }));

      await expect(bed.service.post(args({ generateLedgerOps: async () => transfer(10n) }))).resolves.toEqual({
        fromWinner: true,
      });
    });

    it('retries when a duplicate key is raised but no record is visible yet', async () => {
      const generateLedgerOps = jest
        .fn<Promise<LedgerOperation<any>>, [PrePostContext]>()
        .mockRejectedValueOnce(mongoServerError({ code: 11000 }))
        .mockImplementation(async () => transfer(10n));

      await expect(bed.service.post(args({ generateLedgerOps }))).resolves.toBeDefined();
      expect(generateLedgerOps).toHaveBeenCalledTimes(2);
    });

    it('rethrows a business error without retrying, and still ends the session', async () => {
      const generateLedgerOps = jest.fn(async () => {
        throw AppError.collectionAlreadyReceived('col-1');
      });

      await expect(bed.service.post(args({ generateLedgerOps }))).rejects.toMatchObject({
        code: ErrorCode.COLLECTION_ALREADY_RECEIVED,
      });
      expect(generateLedgerOps).toHaveBeenCalledTimes(1);
      expect(bed.session.endSession).toHaveBeenCalledTimes(1);
    });

    it('tolerates abortTransaction itself failing', async () => {
      bed.session.abortTransaction.mockRejectedValue(new Error('already aborted'));
      const generateLedgerOps = jest.fn(async () => {
        throw new Error('boom');
      });

      await expect(bed.service.post(args({ generateLedgerOps }))).rejects.toThrow('boom');
    });

    it('opens the transaction with snapshot reads and majority writes', async () => {
      await bed.service.post(args({ generateLedgerOps: async () => transfer(10n) }));

      expect(bed.session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    });
  });

  describe('PrePostContext', () => {
    const capture = async (): Promise<PrePostContext> => {
      let captured!: PrePostContext;
      await bed.service.post(
        args({
          generateLedgerOps: async (ctx) => {
            captured = ctx;
            return operation();
          },
        }),
      );
      return captured;
    };

    it('exposes the transaction session', async () => {
      expect((await capture()).session).toBe(bed.session);
    });

    it('readBalance provisions the wallet before reading it', async () => {
      const ctx = await capture();
      const balance = await ctx.readBalance(OWNER, CURRENCY, 'collection');

      expect(bed.accountsRepo.ensureUserWallet).toHaveBeenCalledWith(
        TENANT,
        OWNER,
        CURRENCY,
        'collection',
        bed.session,
      );
      expect(bed.accountsRepo.balanceBreakdown).toHaveBeenCalledWith(
        TENANT,
        OWNER,
        CURRENCY,
        'collection',
        bed.session,
      );
      expect(balance).toMatchObject({ ownerId: OWNER, currency: CURRENCY });
    });

    it('referenceNetAmount sums signed postings for one account', async () => {
      bed.postings.find.mockReturnValue(
        mockQuery([
          { direction: 'credit', amount: Types.Decimal128.fromString('1000') },
          { direction: 'debit', amount: Types.Decimal128.fromString('250') },
        ]),
      );

      const ctx = await capture();
      await expect(ctx.referenceNetAmount('col-1', heldInflow)).resolves.toBe(750n);
      expect(bed.postings.find).toHaveBeenCalledWith(
        { tenantId: TENANT, reference: 'col-1', accountId: idOf(heldInflow) },
        null,
        { session: bed.session },
      );
    });

    it('referenceNetAmount narrows by operation type when asked', async () => {
      const ctx = await capture();
      await ctx.referenceNetAmount('col-1', systemCollection, ['collection.receive']);

      expect(bed.postings.find).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: idOf(systemCollection),
          operationType: { $in: ['collection.receive'] },
        }),
        null,
        { session: bed.session },
      );
    });

    it('referenceNetAmount is zero when nothing was ever posted', async () => {
      const ctx = await capture();
      await expect(ctx.referenceNetAmount('never', heldInflow)).resolves.toBe(0n);
    });

    it('referenceEntryIds returns the ids oldest first', async () => {
      const query = mockQuery([{ _id: 'entry-1' }, { _id: 'entry-2' }]);
      bed.entries.find.mockReturnValue(query);

      const ctx = await capture();
      await expect(ctx.referenceEntryIds('po-1', 'payout.success')).resolves.toEqual([
        'entry-1',
        'entry-2',
      ]);
      expect(bed.entries.find).toHaveBeenCalledWith(
        { tenantId: TENANT, reference: 'po-1', operationType: 'payout.success' },
        null,
        { session: bed.session },
      );
      expect(query.sort).toHaveBeenCalledWith({ createdAt: 1 });
    });
  });

  describe('PostPostingContext', () => {
    it('reads balances back inside the same transaction', async () => {
      await bed.service.post(
        args({
          generateLedgerOps: async () =>
            operation({
              ...transfer(10n),
              buildResponse: async (post) => post.accountBalance(OWNER, CURRENCY, 'collection'),
            }),
        }),
      );

      expect(bed.accountsRepo.balanceBreakdown).toHaveBeenLastCalledWith(
        TENANT,
        OWNER,
        CURRENCY,
        'collection',
        bed.session,
      );
    });

    it('hands one entry id per entry, in order', async () => {
      const two = operation({
        entries: [
          {
            currency: CURRENCY,
            reference: 'a',
            postings: [
              { account: systemCollection, direction: 'debit', amount: 1n },
              { account: heldInflow, direction: 'credit', amount: 1n },
            ],
          },
          {
            currency: CURRENCY,
            reference: 'b',
            postings: [
              { account: systemCollection, direction: 'debit', amount: 2n },
              { account: heldInflow, direction: 'credit', amount: 2n },
            ],
          },
        ],
      });

      const result = await bed.service.post(args({ generateLedgerOps: async () => two }));

      expect(result.entryIds).toEqual(bed.writtenEntries.map((e) => e._id));
      expect(result.entryIds).toHaveLength(2);
      expect(bed.writtenEntries.map((e) => e.reference)).toEqual(['a', 'b']);
    });
  });
});
