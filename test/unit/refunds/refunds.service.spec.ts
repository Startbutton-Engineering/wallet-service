import { RefundsService } from '../../../src/refunds/refunds.service';
import { RefundOperation, RefundStatus } from '../../../src/refunds/refund-transitions';
import { RefundFeeOperation, RefundFeeStatus } from '../../../src/refunds/refund-fee-transitions';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
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
  refundId: 'rf-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 150n,
  status: 'pending' as RefundStatus,
  allowOverdraft: true,
};

describe('RefundsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let service: RefundsService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known: [CURRENCY] });
    service = new RefundsService(ledger.service, currencies.asService);
    return service;
  };

  beforeEach(() => build({ balance: () => walletBalance({ available: 100n }) }));

  it('posts the pending step under refund.pending, referenced by the refund id', async () => {
    await service.status(base);

    expect(ledger.lastCall).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      operationType: RefundOperation.pending,
      reference: 'rf-1',
      requestPayload: {
        refundId: 'rf-1',
        ownerId: OWNER,
        currency: CURRENCY,
        amount: '150',
        status: 'pending',
        allowOverdraft: true,
      },
    });
  });

  it('carries the overdraft split through to the ledger operation', async () => {
    await service.status(base);

    expect(ledger.lastOperation.entries[0].postings.map((p: any) => [p.account.accountType ?? p.account.name, p.direction, p.amount])).toEqual([
      ['available', 'debit', 100n],
      ['refund-chargeback', 'debit', 50n],
      ['external:refunds', 'credit', 150n],
    ]);
    expect(ledger.lastOperation.guardNegative).toHaveLength(1);
  });

  it('returns the ids, the status and the collection wallet balance', async () => {
    await expect(service.status(base)).resolves.toEqual({
      operationId: ledger.operationId,
      entryId: 'entry-1',
      refundId: 'rf-1',
      status: 'pending',
      balance: expect.objectContaining({ walletType: 'collection' }),
    });
    expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'collection');
  });

  it('emits the transition event with the split on it', async () => {
    await service.status(base);

    expect(ledger.events).toEqual([
      {
        type: OutboxEventType.REFUND_PENDING,
        schemaVersion: 1,
        payload: expect.objectContaining({
          operationId: ledger.operationId,
          refundId: 'rf-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '150',
          status: 'pending',
          fromAvailable: '100',
          deficit: '50',
        }),
      },
    ]);
  });

  it.each([
    ['success', RefundOperation.success, OutboxEventType.REFUND_SUCCEEDED],
    ['failed', RefundOperation.failed, OutboxEventType.REFUND_FAILED],
  ] as [RefundStatus, string, OutboxEventType][])(
    'routes %s to its own operation type and event',
    async (status, operationType, eventType) => {
      build({
        netAmount: (_ref, account) => ((account as any).name === 'external:refunds' ? 150n : 0n),
        entryIdsFor: () => ['entry-pending'],
      });

      await service.status({ ...base, status });

      expect(ledger.lastCall.operationType).toBe(operationType);
      expect(ledger.events[0].type).toBe(eventType);
    },
  );

  it('cites the pending entry when a refund fails', async () => {
    build({
      netAmount: (_ref, account) => ((account as any).name === 'external:refunds' ? 150n : 0n),
      entryIdsFor: () => ['entry-pending'],
    });

    await service.status({ ...base, status: 'failed' });
    expect(ledger.lastOperation.reversalOf).toBe('entry-pending');
  });

  it('surfaces a transition precondition failure', async () => {
    build({ netAmount: () => 150n });

    await expect(service.status(base)).rejects.toMatchObject({
      code: ErrorCode.REFUND_ALREADY_INITIATED,
      details: { refundId: 'rf-1' },
    });
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.status({ ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  describe('feeStatus', () => {
    const fee = {
      tenantId: TENANT,
      idempotencyKey: 'key-fee',
      refundId: 'rf-1',
      transferReference: 'trf_rf-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 50n,
      status: 'initiated' as RefundFeeStatus,
    };
    // The refund itself is pending (on external:refunds under rf-1); the fee has not started.
    const refundPending = (reference: string, account: any) =>
      reference === 'rf-1' && account.name === 'external:refunds' ? 1000n : 0n;

    beforeEach(() => build({ netAmount: refundPending }));

    it('posts under the fee operation, referenced by the transfer reference', async () => {
      await service.feeStatus(fee);

      expect(ledger.lastCall).toMatchObject({
        idempotencyKey: 'key-fee',
        operationType: RefundFeeOperation.initiate,
        reference: 'trf_rf-1',
        requestPayload: {
          refundId: 'rf-1',
          transferReference: 'trf_rf-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '50',
          status: 'initiated',
        },
      });
    });

    it('carries the refund id on the posted entry metadata', async () => {
      await service.feeStatus(fee);
      expect(ledger.lastOperation.entries[0].metadata).toMatchObject({ refundId: 'rf-1', transferReference: 'trf_rf-1' });
    });

    it('returns the ids, the status and the collection wallet balance', async () => {
      await expect(service.feeStatus(fee)).resolves.toEqual({
        operationId: ledger.operationId,
        entryId: 'entry-1',
        refundId: 'rf-1',
        transferReference: 'trf_rf-1',
        status: 'initiated',
        balance: expect.objectContaining({ walletType: 'collection' }),
      });
    });

    it('emits the fee event naming the refund', async () => {
      await service.feeStatus(fee);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.REFUND_FEE_INITIATED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            refundId: 'rf-1',
            transferReference: 'trf_rf-1',
            amount: '50',
            status: 'initiated',
          }),
        },
      ]);
    });

    it.each([
      ['success', RefundFeeOperation.success, OutboxEventType.REFUND_FEE_SUCCEEDED],
      ['reversed', RefundFeeOperation.reverse, OutboxEventType.REFUND_FEE_REVERSED],
    ] as [RefundFeeStatus, string, OutboxEventType][])(
      'routes %s to its own operation type and event',
      async (status, operationType, eventType) => {
        build({ netAmount: () => 50n, entryIdsFor: () => ['entry-fee-initiate'] });

        await service.feeStatus({ ...fee, status });

        expect(ledger.lastCall.operationType).toBe(operationType);
        expect(ledger.events[0].type).toBe(eventType);
      },
    );

    it('cites the fee initiation when the fee is reversed', async () => {
      build({ netAmount: () => 50n, entryIdsFor: () => ['entry-fee-initiate'] });
      await service.feeStatus({ ...fee, status: 'reversed' });
      expect(ledger.lastOperation.reversalOf).toBe('entry-fee-initiate');
    });

    it('routes reverse-failed to its own operation type and event', async () => {
      build({ netAmount: () => 50n });
      await service.feeStatus({ ...fee, status: 'reverse-failed' });

      expect(ledger.lastCall.operationType).toBe(RefundFeeOperation.reverseFailed);
      expect(ledger.events[0].type).toBe(OutboxEventType.REFUND_FEE_REVERSE_FAILED);
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      await expect(service.feeStatus({ ...fee, currency: 'XXX' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
      expect(ledger.post).not.toHaveBeenCalled();
    });
  });
});
