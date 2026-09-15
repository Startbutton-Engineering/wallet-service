import { CollectionsService } from '../../../src/collections/collection.service';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import { AccountRef, System } from '../../../src/accounts/account';
import {
  CURRENCY,
  OWNER,
  TENANT,
  LedgerHarness,
  LedgerHarnessOptions,
  mockCurrencyRegistry,
  walletBalance,
} from '../../mocks';

const base = {
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  collectionId: 'col-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 1000n,
};

/** Renders a posting as [account label, direction, amount] for readable assertions. */
const label = (account: AccountRef): string =>
  account.kind === 'user' ? `${account.walletType}:${account.accountType}` : `system:${account.name}`;

const legs = (entry: { postings: { account: AccountRef; direction: string; amount: bigint }[] }) =>
  entry.postings.map((p) => [label(p.account), p.direction, p.amount]);

describe('CollectionsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let service: CollectionsService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known: [CURRENCY] });
    service = new CollectionsService(ledger.service, currencies.asService);
    return service;
  };

  beforeEach(() => build());

  describe('collect', () => {
    it('debits the external collection account into held-inflow', async () => {
      await service.collect(base);

      const [entry] = ledger.lastOperation.entries;
      expect(entry.currency).toBe(CURRENCY);
      expect(legs(entry)).toEqual([
        [`system:${System.collection}`, 'debit', 1000n],
        ['collection:held-inflow', 'credit', 1000n],
      ]);
    });

    it('posts under collection.receive, referenced by the collection id', async () => {
      await service.collect(base);

      expect(ledger.lastCall).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        operationType: 'collection.receive',
        reference: 'col-1',
        requestPayload: { collectionId: 'col-1', ownerId: OWNER, currency: CURRENCY, amount: '1000' },
      });
    });

    it('guards held-inflow against going negative', async () => {
      await service.collect(base);
      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['collection:held-inflow']);
    });

    it('returns the ids and the collection wallet balance', async () => {
      await expect(service.collect(base)).resolves.toEqual({
        operationId: ledger.operationId,
        entryId: 'entry-1',
        collectionId: 'col-1',
        balance: expect.objectContaining({ walletType: 'collection' }),
      });
    });

    it('emits a single CollectionReceived event', async () => {
      await service.collect(base);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.COLLECTION_RECEIVED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            collectionId: 'col-1',
            ownerId: OWNER,
            currency: CURRENCY,
            amount: '1000',
          }),
        },
      ]);
    });

    it('only counts collection.receive postings when checking for a replay', async () => {
      await service.collect(base);

      expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
        'col-1',
        expect.objectContaining({ accountType: 'held-inflow' }),
        ['collection.receive'],
      );
    });

    it('rejects receiving the same collection twice', async () => {
      build({ netAmount: () => 1000n });

      await expect(service.collect(base)).rejects.toMatchObject({
        code: ErrorCode.COLLECTION_ALREADY_RECEIVED,
        details: { collectionId: 'col-1' },
      });
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      await expect(service.collect({ ...base, currency: 'XXX' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
      expect(ledger.post).not.toHaveBeenCalled();
    });
  });

  describe('settled', () => {
    it('releases held-inflow into available when the owner carries no debt', async () => {
      build({ netAmount: () => 1000n });

      await service.settled(base);

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['collection:held-inflow', 'debit', 1000n],
        ['collection:available', 'credit', 1000n],
      ]);
    });

    it('pays down a refund-chargeback debt first, crediting only the remainder', async () => {
      build({
        netAmount: () => 1000n,
        balance: () => walletBalance({ refundChargeback: -400n }),
      });

      await service.settled(base);

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['collection:held-inflow', 'debit', 1000n],
        ['collection:refund-chargeback', 'credit', 400n],
        ['collection:available', 'credit', 600n],
      ]);
    });

    it('reports the split on the event and adds a debt-settled event', async () => {
      build({
        netAmount: () => 1000n,
        balance: () => walletBalance({ refundChargeback: -400n }),
      });

      await service.settled(base);

      expect(ledger.events.map((e) => e.type)).toEqual([
        OutboxEventType.COLLECTION_SETTLED,
        'ReffunChargebackSettled',
      ]);
      expect(ledger.events[0].payload).toMatchObject({
        settledToDebit: '400',
        amountToCredit: '600',
      });
    });

    it('emits only the settled event when there was no debt', async () => {
      build({ netAmount: () => 1000n });

      await service.settled(base);

      expect(ledger.events.map((e) => e.type)).toEqual([OutboxEventType.COLLECTION_SETTLED]);
      expect(ledger.events[0].payload).toMatchObject({ settledToDebit: '0', amountToCredit: '1000' });
    });

    it('allows a partial settlement of the outstanding hold', async () => {
      build({ netAmount: () => 1000n });

      await service.settled({ ...base, amount: 400n });

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['collection:held-inflow', 'debit', 400n],
        ['collection:available', 'credit', 400n],
      ]);
    });

    it('rejects settling more than is outstanding', async () => {
      build({ netAmount: () => 600n });

      await expect(service.settled(base)).rejects.toMatchObject({
        code: ErrorCode.COLLECTION_OVER_SETTLEMENT,
        details: { collectionId: 'col-1', requested: '1000', outstanding: '600' },
      });
    });

    it('rejects settling a collection that was never received', async () => {
      await expect(service.settled(base)).rejects.toMatchObject({
        code: ErrorCode.COLLECTION_OVER_SETTLEMENT,
        details: { outstanding: '0' },
      });
    });

    it('counts every operation type when measuring what is still outstanding', async () => {
      build({ netAmount: () => 1000n });

      await service.settled(base);

      expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
        'col-1',
        expect.objectContaining({ accountType: 'held-inflow' }),
      );
    });

    it('posts under collection.settle', async () => {
      build({ netAmount: () => 1000n });
      await service.settled(base);
      expect(ledger.lastCall.operationType).toBe('collection.settle');
    });
  });

  describe('settleBatch', () => {
    const items = [
      { collectionId: 'col-1', amount: 400n },
      { collectionId: 'col-2', amount: 600n },
    ];
    const batch = { tenantId: TENANT, idempotencyKey: 'key-1', ownerId: OWNER, currency: CURRENCY, items };

    it('writes one entry per collection, each referencing its own collection id', async () => {
      build({ netAmount: () => 1000n });

      await service.settleBatch(batch);

      const entries = ledger.lastOperation.entries;
      expect(entries.map((e) => e.reference)).toEqual(['col-1', 'col-2']);
      expect(legs(entries[0])).toEqual([
        ['collection:held-inflow', 'debit', 400n],
        ['collection:available', 'credit', 400n],
      ]);
      expect(legs(entries[1])).toEqual([
        ['collection:held-inflow', 'debit', 600n],
        ['collection:available', 'credit', 600n],
      ]);
    });

    it('reads the wallet balance once and carries the debt across items', async () => {
      build({
        netAmount: () => 1000n,
        balance: () => walletBalance({ refundChargeback: -500n }),
      });

      await service.settleBatch(batch);

      expect(ledger.readBalance).toHaveBeenCalledTimes(1);
      const entries = ledger.lastOperation.entries;
      // The first item clears 400 of the 500 debt, leaving 100 for the second.
      expect(legs(entries[0])).toEqual([
        ['collection:held-inflow', 'debit', 400n],
        ['collection:refund-chargeback', 'credit', 400n],
      ]);
      expect(legs(entries[1])).toEqual([
        ['collection:held-inflow', 'debit', 600n],
        ['collection:refund-chargeback', 'credit', 100n],
        ['collection:available', 'credit', 500n],
      ]);
    });

    it('returns a per-item breakdown with the entry id of each collection', async () => {
      build({ netAmount: () => 1000n, balance: () => walletBalance({ refundChargeback: -500n }) });

      await expect(service.settleBatch(batch)).resolves.toEqual({
        operationId: ledger.operationId,
        items: [
          { collectionId: 'col-1', entryId: 'entry-1', amountToCredit: '0', settledToDebit: '400' },
          { collectionId: 'col-2', entryId: 'entry-2', amountToCredit: '500', settledToDebit: '100' },
        ],
        balance: expect.objectContaining({ walletType: 'collection' }),
      });
    });

    it('posts the batch total on one settled event, with no collectionId', async () => {
      build({ netAmount: () => 1000n });

      await service.settleBatch(batch);

      expect(ledger.events).toHaveLength(1);
      expect(ledger.events[0].type).toBe(OutboxEventType.COLLECTION_SETTLED);
      expect(ledger.events[0].payload).toMatchObject({ amount: '1000', items: expect.any(Array) });
      expect(ledger.events[0].payload).not.toHaveProperty('collectionId');
    });

    it('adds the debt-settled event when any item paid down debt', async () => {
      build({ netAmount: () => 1000n, balance: () => walletBalance({ refundChargeback: -100n }) });

      await service.settleBatch(batch);

      expect(ledger.events.map((e) => e.type)).toEqual([
        OutboxEventType.COLLECTION_SETTLED,
        'ReffunChargebackSettled',
      ]);
    });

    it('posts under collection.settle.batch with no top-level reference', async () => {
      build({ netAmount: () => 1000n });

      await service.settleBatch(batch);

      expect(ledger.lastCall).toMatchObject({
        operationType: 'collection.settle.batch',
        requestPayload: {
          ownerId: OWNER,
          currency: CURRENCY,
          items: [
            { collectionId: 'col-1', amount: '400' },
            { collectionId: 'col-2', amount: '600' },
          ],
        },
      });
      expect(ledger.lastCall.reference).toBeUndefined();
    });

    it('guards held-inflow for the whole batch', async () => {
      build({ netAmount: () => 1000n });
      await service.settleBatch(batch);
      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['collection:held-inflow']);
    });

    it('rejects the whole batch when one item over-settles, naming that item', async () => {
      build({ netAmount: (reference) => (reference === 'col-2' ? 100n : 1000n) });

      await expect(service.settleBatch(batch)).rejects.toMatchObject({
        code: ErrorCode.COLLECTION_OVER_SETTLEMENT,
        details: { collectionId: 'col-2', requested: '600', outstanding: '100' },
      });
    });

    it('checks the outstanding amount per collection id', async () => {
      build({ netAmount: () => 1000n });

      await service.settleBatch(batch);

      expect(ledger.referenceNetAmount).toHaveBeenCalledWith('col-1', expect.anything());
      expect(ledger.referenceNetAmount).toHaveBeenCalledWith('col-2', expect.anything());
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      await expect(service.settleBatch({ ...batch, currency: 'XXX' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('handles a single-item batch', async () => {
      build({ netAmount: () => 1000n });

      const result = await service.settleBatch({ ...batch, items: [items[0]] });
      expect(result.items).toHaveLength(1);
      expect(ledger.lastOperation.entries).toHaveLength(1);
    });
  });
});
