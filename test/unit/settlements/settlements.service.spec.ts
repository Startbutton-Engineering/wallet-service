import { SettlementsService } from '../../../src/settlements/settlements.service';
import { SettlementOperation } from '../../../src/settlements/settlement-transitions';
import { EntriesRepository } from '../../../src/ledger/entries.repository';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import {
  OWNER,
  TENANT,
  LedgerHarness,
  LedgerHarnessOptions,
  mockCurrencyRegistry,
} from '../../mocks';

const initiateParams = {
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  settlementId: 'st-1',
  ownerId: OWNER,
  currency: 'USD',
  amount: 10_500n,
  walletType: 'collection' as const,
};

const resolveParams = {
  tenantId: TENANT,
  idempotencyKey: 'key-2',
  settlementId: 'st-1',
  ownerId: OWNER,
  currency: 'USD',
  walletType: 'collection' as const,
};

function mockEntriesRepository(rows: unknown[] = []) {
  const findUnresolvedInitiations = jest.fn(async () => rows);
  return {
    findUnresolvedInitiations,
    asRepository: { findUnresolvedInitiations } as unknown as EntriesRepository,
  };
}

describe('SettlementsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let entries: ReturnType<typeof mockEntriesRepository>;
  let service: SettlementsService;

  const build = (options: LedgerHarnessOptions = {}, rows: unknown[] = [], known: string[] = ['USD', 'NGN']) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known });
    entries = mockEntriesRepository(rows);
    service = new SettlementsService(ledger.service, currencies.asService, entries.asRepository);
  };

  beforeEach(() => build());

  describe('initiate', () => {
    it('posts under settlement.initiate, referenced by the settlement id', async () => {
      await service.initiate(initiateParams);

      expect(ledger.lastCall).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        operationType: SettlementOperation.initiate,
        reference: 'st-1',
        requestPayload: {
          settlementId: 'st-1', ownerId: OWNER, currency: 'USD', amount: '10500', walletType: 'collection',
        },
      });
      expect(ledger.lastOperation.guardNegative).toHaveLength(1);
    });

    it('returns the held amount and the wallet balance', async () => {
      await expect(service.initiate(initiateParams)).resolves.toEqual({
        operationId: ledger.operationId,
        entryId: 'entry-1',
        settlementId: 'st-1',
        status: 'initiated',
        currency: 'USD',
        amount: '10500',
        walletType: 'collection',
        balance: expect.objectContaining({ currency: 'USD', walletType: 'collection' }),
      });
      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'USD', 'collection');
    });

    it('emits SettlementInitiated', async () => {
      await service.initiate(initiateParams);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.SETTLEMENT_INITIATED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            settlementId: 'st-1',
            ownerId: OWNER,
            currency: 'USD',
            amount: '10500',
            status: 'initiated',
            walletType: 'collection',
          }),
        },
      ]);
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      build({}, [], ['NGN']);

      await expect(service.initiate(initiateParams)).rejects.toMatchObject({ code: ErrorCode.INVALID_CURRENCY });
      expect(ledger.post).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it.each([
      ['success', SettlementOperation.success, OutboxEventType.SETTLEMENT_SUCCEEDED],
      ['failed', SettlementOperation.failed, OutboxEventType.SETTLEMENT_FAILED],
    ] as const)('routes %s to its own operation type and event', async (status, operationType, eventType) => {
      build({ netAmount: () => 10_500n });

      const result = await service.resolve({ ...resolveParams, status });

      expect(ledger.lastCall.operationType).toBe(operationType);
      expect(ledger.lastCall.reference).toBe('st-1');
      expect(ledger.events[0].type).toBe(eventType);
      expect(result).toMatchObject({ status, amount: '10500' });
    });

    it('never includes an amount in the request payload', async () => {
      build({ netAmount: () => 10_500n });

      await service.resolve({ ...resolveParams, status: 'success' });

      expect(ledger.lastCall.requestPayload).toEqual({
        settlementId: 'st-1', ownerId: OWNER, currency: 'USD', status: 'success', walletType: 'collection',
      });
    });

    it('surfaces a transition precondition failure', async () => {
      await expect(service.resolve({ ...resolveParams, status: 'success' }))
        .rejects.toMatchObject({ code: ErrorCode.SETTLEMENT_NOT_INITIATED });
    });

    it('reads the wallet named by walletType', async () => {
      build({ netAmount: () => 10_500n });

      await service.resolve({ ...resolveParams, walletType: 'payout', status: 'failed' });

      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, 'USD', 'payout');
    });
  });

  describe('listPending', () => {
    it('asks for initiations with no success or failed entry and maps their metadata', async () => {
      const initiatedAt = new Date('2026-09-28T10:00:00Z');
      build({}, [
        {
          reference: 'st-1',
          createdAt: initiatedAt,
          metadata: { ownerId: OWNER, currency: 'USD', amount: '10500', walletType: 'payout' },
        },
      ]);

      await expect(service.listPending(TENANT, 10)).resolves.toEqual([
        { settlementId: 'st-1', ownerId: OWNER, currency: 'USD', amount: '10500', walletType: 'payout', initiatedAt },
      ]);
      expect(entries.findUnresolvedInitiations).toHaveBeenCalledWith(
        TENANT,
        SettlementOperation.initiate,
        [SettlementOperation.success, SettlementOperation.failed],
        { limit: 10 },
      );
    });
  });
});
