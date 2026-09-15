import { PayoutsService } from '../../../src/payouts/payouts.service';
import { PayoutOperation, PayoutStatus } from '../../../src/payouts/payout-transitions';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import {
  CURRENCY,
  OWNER,
  TENANT,
  LedgerHarness,
  LedgerHarnessOptions,
  mockCurrencyRegistry,
} from '../../mocks';

const base = {
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  payoutId: 'po-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 10_500n,
  status: 'initiated' as PayoutStatus,
};

describe('PayoutsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let service: PayoutsService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known: [CURRENCY] });
    service = new PayoutsService(ledger.service, currencies.asService);
    return service;
  };

  beforeEach(() => build());

  it('posts an initiation under payout.initiate, referenced by the payout id', async () => {
    await service.status(base);

    expect(ledger.lastCall).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      operationType: PayoutOperation.initiate,
      reference: 'po-1',
      requestPayload: {
        payoutId: 'po-1',
        ownerId: OWNER,
        currency: CURRENCY,
        amount: '10500',
        status: 'initiated',
      },
    });
  });

  it('carries the transition plan through to the ledger operation', async () => {
    await service.status(base);

    const operation = ledger.lastOperation;
    expect(operation.entries).toHaveLength(1);
    expect(operation.entries[0].postings.map((p: any) => [p.account.accountType, p.direction])).toEqual([
      ['available', 'debit'],
      ['held-outflow', 'credit'],
    ]);
    expect(operation.guardNegative).toHaveLength(1);
  });

  it('returns the ids, the status and the payout wallet balance', async () => {
    await expect(service.status(base)).resolves.toEqual({
      operationId: ledger.operationId,
      entryId: 'entry-1',
      payoutId: 'po-1',
      status: 'initiated',
      balance: expect.objectContaining({ walletType: 'payout' }),
    });
  });

  it('emits the event that matches the transition', async () => {
    await service.status(base);

    expect(ledger.events).toEqual([
      {
        type: OutboxEventType.PAYOUT_INITIATED,
        schemaVersion: 1,
        payload: expect.objectContaining({
          operationId: ledger.operationId,
          payoutId: 'po-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '10500',
          status: 'initiated',
        }),
      },
    ]);
  });

  it.each([
    ['success', PayoutOperation.success, OutboxEventType.PAYOUT_SUCCEEDED],
    ['failed', PayoutOperation.failed, OutboxEventType.PAYOUT_FAILED],
  ] as [PayoutStatus, string, OutboxEventType][])(
    'routes %s to its own operation type and event',
    async (status, operationType, eventType) => {
      build({ netAmount: () => 10_500n });

      await service.status({ ...base, status });

      expect(ledger.lastCall.operationType).toBe(operationType);
      expect(ledger.events[0].type).toBe(eventType);
    },
  );

  it('routes a reversal to payout.reverse and cites the success entry it undoes', async () => {
    build({ netAmount: () => 10_500n, entryIdsFor: () => ['entry-success'] });

    await service.status({ ...base, status: 'reversed' });

    expect(ledger.lastCall.operationType).toBe(PayoutOperation.reverse);
    expect(ledger.lastOperation.reversalOf).toBe('entry-success');
    expect(ledger.events[0].type).toBe(OutboxEventType.PAYOUT_REVERSED);
  });

  it('routes reverse-failed to its own operation type and event', async () => {
    build({ netAmount: () => 10_500n });

    await service.status({ ...base, status: 'reverse-failed' });

    expect(ledger.lastCall.operationType).toBe(PayoutOperation.reverseFailed);
    expect(ledger.events[0].type).toBe(OutboxEventType.PAYOUT_REVERSE_FAILED);
  });

  it('leaves reversalOf undefined for a transition that undoes nothing', async () => {
    await service.status(base);
    expect(ledger.lastOperation.reversalOf).toBeUndefined();
  });

  it('surfaces a transition precondition failure', async () => {
    build({ netAmount: () => 10_500n });

    await expect(service.status(base)).rejects.toMatchObject({
      code: ErrorCode.PAYOUT_ALREADY_INITIATED,
      details: { payoutId: 'po-1' },
    });
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.status({ ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('reads the payout wallet, not the collection wallet', async () => {
    await service.status(base);
    expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'payout');
  });
});
