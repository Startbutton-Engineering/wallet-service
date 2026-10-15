import { RollingReserveOperation, RollingReservesService } from '../../../src/rolling-reserves/rolling-reserves.service';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import { AccountRef } from '../../../src/accounts/account';
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
  releaseId: 'RR-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 300n,
};

const label = (account: AccountRef): string =>
  account.kind === 'user' ? `${account.walletType}:${account.accountType}` : `system:${account.name}`;

const legs = (entry: { postings: { account: AccountRef; direction: string; amount: bigint }[] }) =>
  entry.postings.map((p) => [label(p.account), p.direction, p.amount]);

describe('RollingReservesService', () => {
  let ledger: LedgerHarness;
  let service: RollingReservesService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    service = new RollingReservesService(ledger.service, mockCurrencyRegistry({ known: [CURRENCY] }).asService);
    return service;
  };

  beforeEach(() => build({ balance: () => walletBalance({ available: 100n }) }));

  it('posts under rolling-reserve.release, referenced by the release id', async () => {
    await service.release(base);

    expect(ledger.lastCall).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      operationType: RollingReserveOperation.release,
      reference: 'RR-1',
      requestPayload: { releaseId: 'RR-1', ownerId: OWNER, currency: CURRENCY, amount: '300' },
    });
  });

  it('debits external:collection and credits collection available, with no guard', async () => {
    await expect(service.release(base)).resolves.toMatchObject({ settledToDebit: '0', amountToCredit: '300' });

    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['system:external:collection', 'debit', 300n],
      ['collection:available', 'credit', 300n],
    ]);
    expect(ledger.lastOperation.guardNegative).toEqual([]);
  });

  it('repays refund-chargeback debt before crediting available', async () => {
    build({ balance: () => walletBalance({ available: 0n, refundChargeback: -120n }) });

    await expect(service.release(base)).resolves.toMatchObject({ settledToDebit: '120', amountToCredit: '180' });
    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['system:external:collection', 'debit', 300n],
      ['collection:refund-chargeback', 'credit', 120n],
      ['collection:available', 'credit', 180n],
    ]);
  });

  it('rejects a release id that has already been applied', async () => {
    build({ netAmount: () => -300n });

    await expect(service.release(base)).rejects.toMatchObject({
      code: ErrorCode.ROLLING_RESERVE_ALREADY_RELEASED,
      details: { releaseId: 'RR-1' },
    });
    expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
      'RR-1',
      expect.objectContaining({ kind: 'system', name: 'external:collection' }),
      [RollingReserveOperation.release],
    );
  });

  it('returns the ids, the split and the collection wallet balance', async () => {
    await expect(service.release(base)).resolves.toEqual({
      operationId: ledger.operationId,
      entryId: 'entry-1',
      releaseId: 'RR-1',
      settledToDebit: '0',
      amountToCredit: '300',
      balance: expect.objectContaining({ walletType: 'collection' }),
    });
    expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'collection');
  });

  it('emits RollingReserveReleased only when no debt was repaid', async () => {
    await service.release(base);

    expect(ledger.events).toEqual([
      {
        type: OutboxEventType.ROLLING_RESERVE_RELEASED,
        schemaVersion: 1,
        payload: expect.objectContaining({
          operationId: ledger.operationId,
          releaseId: 'RR-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '300',
          settledToDebit: '0',
          amountToCredit: '300',
        }),
      },
    ]);
  });

  it('also emits RefundChargebackSettled when the release repaid debt', async () => {
    build({ balance: () => walletBalance({ refundChargeback: -50n }) });

    await service.release(base);

    expect(ledger.events.map((e) => e.type)).toEqual([
      OutboxEventType.ROLLING_RESERVE_RELEASED,
      OutboxEventType.REFUND_CHARGEBACK_SETTLED,
    ]);
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.release({ ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
