import { DisputeOperation, DisputesService } from '../../../src/disputes/disputes.service';
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
  disputeId: 'dsp-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 150n,
  allowOverdraft: true,
};

const label = (account: AccountRef): string =>
  account.kind === 'user' ? `${account.walletType}:${account.accountType}` : `system:${account.name}`;

const legs = (entry: { postings: { account: AccountRef; direction: string; amount: bigint }[] }) =>
  entry.postings.map((p) => [label(p.account), p.direction, p.amount]);

describe('DisputesService', () => {
  let ledger: LedgerHarness;
  let service: DisputesService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    service = new DisputesService(ledger.service, mockCurrencyRegistry({ known: [CURRENCY] }).asService);
    return service;
  };

  beforeEach(() => build({ balance: () => walletBalance({ available: 100n }) }));

  it('posts under dispute.accept, referenced by the dispute id', async () => {
    await service.accept(base);

    expect(ledger.lastCall).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      operationType: DisputeOperation.accept,
      reference: 'dsp-1',
      requestPayload: { disputeId: 'dsp-1', ownerId: OWNER, currency: CURRENCY, amount: '150', allowOverdraft: true },
    });
  });

  it('debits available in full when it covers the dispute', async () => {
    build({ balance: () => walletBalance({ available: 500n }) });

    await expect(service.accept(base)).resolves.toMatchObject({ fromAvailable: '150', deficit: '0' });
    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['collection:available', 'debit', 150n],
      ['system:external:collection', 'credit', 150n],
    ]);
  });

  it('books the shortfall as refund-chargeback debt when overdraft is allowed', async () => {
    await expect(service.accept(base)).resolves.toMatchObject({ fromAvailable: '100', deficit: '50' });
    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['collection:available', 'debit', 100n],
      ['collection:refund-chargeback', 'debit', 50n],
      ['system:external:collection', 'credit', 150n],
    ]);
    expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['collection:available']);
  });

  it('debits the whole amount from available without overdraft, so the guard rejects a shortfall', async () => {
    await service.accept({ ...base, allowOverdraft: false });

    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['collection:available', 'debit', 150n],
      ['system:external:collection', 'credit', 150n],
    ]);
    expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['collection:available']);
  });

  it('rejects a dispute that has already been accepted', async () => {
    build({ netAmount: () => 150n });

    await expect(service.accept(base)).rejects.toMatchObject({
      code: ErrorCode.DISPUTE_ALREADY_ACCEPTED,
      details: { disputeId: 'dsp-1' },
    });
    expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
      'dsp-1',
      expect.objectContaining({ kind: 'system', name: 'external:collection' }),
      [DisputeOperation.accept],
    );
  });

  it('returns the ids, the split and the collection wallet balance', async () => {
    await expect(service.accept(base)).resolves.toEqual({
      operationId: ledger.operationId,
      entryId: 'entry-1',
      disputeId: 'dsp-1',
      fromAvailable: '100',
      deficit: '50',
      balance: expect.objectContaining({ walletType: 'collection' }),
    });
    expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'collection');
  });

  it('emits DisputeAccepted with the split', async () => {
    await service.accept(base);

    expect(ledger.events).toEqual([
      {
        type: OutboxEventType.DISPUTE_ACCEPTED,
        schemaVersion: 1,
        payload: expect.objectContaining({
          operationId: ledger.operationId,
          disputeId: 'dsp-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '150',
          fromAvailable: '100',
          deficit: '50',
        }),
      },
    ]);
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.accept({ ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
