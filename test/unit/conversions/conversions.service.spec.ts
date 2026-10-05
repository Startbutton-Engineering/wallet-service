import { ConversionsService } from '../../../src/conversions/conversions.service';
import { ConversionOperation } from '../../../src/conversions/conversion-transitions';
import { EntriesRepository } from '../../../src/ledger/entries.repository';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import {
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
  conversionId: 'cv-1',
  ownerId: OWNER,
  fromCurrency: 'NGN',
  toCurrency: 'USD',
  fromAmount: 150_000n,
  rate: '1500',
  walletType: 'collection' as const,
};

function mockEntriesRepository(rows: unknown[] = []): EntriesRepository {
  return { findUnresolvedInitiations: jest.fn(async () => rows) } as unknown as EntriesRepository;
}

describe('ConversionsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let entriesRepo: EntriesRepository;
  let service: ConversionsService;

  const build = (
    options: LedgerHarnessOptions = {},
    rows: unknown[] = [],
    known: string[] = ['NGN', 'USD'],
  ) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known });
    entriesRepo = mockEntriesRepository(rows);
    service = new ConversionsService(ledger.service, currencies.asService, entriesRepo);
    return service;
  };

  beforeEach(() => build());

  describe('initiate', () => {
    it('posts under conversion.initiate, referenced by the conversion id', async () => {
      await service.initiate(base);

      expect(ledger.lastCall).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        operationType: ConversionOperation.initiate,
        reference: 'cv-1',
        requestPayload: {
          conversionId: 'cv-1',
          ownerId: OWNER,
          fromCurrency: 'NGN',
          toCurrency: 'USD',
          fromAmount: '150000',
          rate: '1500',
          walletType: 'collection',
        },
      });
    });

    it('carries the transition plan through to the ledger operation', async () => {
      await service.initiate(base);

      const operation = ledger.lastOperation;
      expect(operation.entries).toHaveLength(2);
      expect(operation.guardNegative).toHaveLength(1);
    });

    it('returns the derived toAmount, currency pair, rate, and both wallet balances', async () => {
      await expect(service.initiate(base)).resolves.toEqual({
        operationId: ledger.operationId,
        entryIds: ['entry-1', 'entry-2'],
        conversionId: 'cv-1',
        status: 'initiated',
        fromCurrency: 'NGN',
        toCurrency: 'USD',
        rate: '1500',
        fromAmount: '150000',
        toAmount: '100',
        walletType: 'collection',
        fromBalance: expect.objectContaining({ currency: 'NGN' }),
        toBalance: expect.objectContaining({ currency: 'USD' }),
      });
    });

    it('emits ConversionInitiated with the derived amounts', async () => {
      await service.initiate(base);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.CONVERSION_INITIATED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            conversionId: 'cv-1',
            ownerId: OWNER,
            fromCurrency: 'NGN',
            toCurrency: 'USD',
            rate: '1500',
            fromAmount: '150000',
            toAmount: '100',
            walletType: 'collection',
          }),
        },
      ]);
    });

    it('checks both currencies of the pair against the registry', async () => {
      await service.initiate(base);
      expect(currencies.require).toHaveBeenCalledWith('NGN');
      expect(currencies.require).toHaveBeenCalledWith('USD');
    });

    it('generalizes to any registered currency pair', async () => {
      build({}, [], ['USD', 'GBP']);
      await service.initiate({ ...base, fromCurrency: 'USD', toCurrency: 'GBP', rate: '1.25' });

      expect(ledger.lastCall.requestPayload).toMatchObject({ fromCurrency: 'USD', toCurrency: 'GBP' });
      expect(currencies.require).toHaveBeenCalledWith('USD');
      expect(currencies.require).toHaveBeenCalledWith('GBP');
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      build({}, [], ['NGN']); // USD not registered

      await expect(service.initiate(base)).rejects.toMatchObject({ code: ErrorCode.INVALID_CURRENCY });
      expect(ledger.post).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it.each([
      ['approved', ConversionOperation.approve, OutboxEventType.CONVERSION_APPROVED],
      ['rejected', ConversionOperation.reject, OutboxEventType.CONVERSION_REJECTED],
    ] as const)('routes %s to its own operation type and event', async (status, operationType, eventType) => {
      build({ netAmount: () => 150_000n });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status, walletType: 'collection',
      });

      expect(ledger.lastCall.operationType).toBe(operationType);
      expect(ledger.events[0].type).toBe(eventType);
    });

    it('never includes an amount or rate in the request payload', async () => {
      build({ netAmount: () => 150_000n });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved', walletType: 'collection',
      });

      expect(ledger.lastCall.requestPayload).toEqual({
        conversionId: 'cv-1', ownerId: OWNER, fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved',
        walletType: 'collection',
      });
    });

    it('surfaces a transition precondition failure', async () => {
      await expect(
        service.resolve({
          tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
          fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved', walletType: 'collection',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONVERSION_NOT_INITIATED });
    });

    it('reads the collection wallet for both currencies of the pair it was given', async () => {
      build({ netAmount: () => 150_000n });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved', walletType: 'collection',
      });

      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'NGN', 'collection');
      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'USD', 'collection');
    });

    it('adds a debt-settled event when an approval repays refund-chargeback debt', async () => {
      build({
        netAmount: () => 150_000n,
        balance: (ownerId, currency, walletType) => walletBalance({ ownerId, currency, walletType, refundChargeback: -40_000n }),
      });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved', walletType: 'collection',
      });

      expect(ledger.events.map((e) => e.type)).toEqual([
        OutboxEventType.CONVERSION_APPROVED,
        OutboxEventType.REFUND_CHARGEBACK_SETTLED,
      ]);
      expect(ledger.events[0].payload).toMatchObject({ settledToDebit: '40000' });
    });

    it('emits no debt-settled event and no settledToDebit when nothing was repaid', async () => {
      build({ netAmount: () => 150_000n });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status: 'rejected', walletType: 'collection',
      });

      expect(ledger.events).toHaveLength(1);
      expect(ledger.events[0].payload).not.toHaveProperty('settledToDebit');
    });

    it('reads the payout wallet for both currencies when walletType is payout', async () => {
      build({ netAmount: () => 150_000n });

      await service.resolve({
        tenantId: TENANT, idempotencyKey: 'key-2', conversionId: 'cv-1', ownerId: OWNER,
        fromCurrency: 'NGN', toCurrency: 'USD', status: 'approved', walletType: 'payout',
      });

      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'NGN', 'payout');
      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'USD', 'payout');
    });
  });

  describe('listPending', () => {
    it('maps repository rows into pending summaries', async () => {
      const initiatedAt = new Date('2026-01-01T00:00:00.000Z');
      build({}, [
        {
          reference: 'cv-1',
          metadata: {
            ownerId: OWNER, fromCurrency: 'NGN', toCurrency: 'USD',
            rate: '1500', fromAmount: '150000', toAmount: '100', walletType: 'payout',
          },
          createdAt: initiatedAt,
        },
      ]);

      await expect(service.listPending(TENANT)).resolves.toEqual([
        {
          conversionId: 'cv-1', ownerId: OWNER, fromCurrency: 'NGN', toCurrency: 'USD',
          rate: '1500', fromAmount: '150000', toAmount: '100', walletType: 'payout', initiatedAt,
        },
      ]);
    });

    it('defaults walletType to collection for entries recorded before the field existed', async () => {
      const initiatedAt = new Date('2026-01-01T00:00:00.000Z');
      build({}, [
        {
          reference: 'cv-1',
          metadata: {
            ownerId: OWNER, fromCurrency: 'NGN', toCurrency: 'USD',
            rate: '1500', fromAmount: '150000', toAmount: '100',
          },
          createdAt: initiatedAt,
        },
      ]);

      await expect(service.listPending(TENANT)).resolves.toEqual([
        {
          conversionId: 'cv-1', ownerId: OWNER, fromCurrency: 'NGN', toCurrency: 'USD',
          rate: '1500', fromAmount: '150000', toAmount: '100', walletType: 'collection', initiatedAt,
        },
      ]);
    });

    it('passes the operation types and limit through to the repository', async () => {
      await service.listPending(TENANT, 10);

      expect(entriesRepo.findUnresolvedInitiations).toHaveBeenCalledWith(
        TENANT,
        ConversionOperation.initiate,
        [ConversionOperation.approve, ConversionOperation.reject],
        { limit: 10 },
      );
    });
  });
});
