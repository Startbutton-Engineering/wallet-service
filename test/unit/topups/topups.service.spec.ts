import { TopupOperation, TopupsService } from '../../../src/topups/topups.service';
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
} from '../../mocks';

const base = {
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  topupId: 'tp-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 1000n,
};

/** Renders a posting as [account label, direction, amount] for readable assertions. */
const label = (account: AccountRef): string =>
  account.kind === 'user' ? `${account.walletType}:${account.accountType}` : `system:${account.name}`;

const legs = (entry: { postings: { account: AccountRef; direction: string; amount: bigint }[] }) =>
  entry.postings.map((p) => [label(p.account), p.direction, p.amount]);

describe('TopupsService', () => {
  let ledger: LedgerHarness;
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let service: TopupsService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    currencies = mockCurrencyRegistry({ known: [CURRENCY] });
    service = new TopupsService(ledger.service, currencies.asService);
    return service;
  };

  beforeEach(() => build());

  it('posts under topup.credit, referenced by the topup id', async () => {
    await service.credit(base);

    expect(ledger.lastCall).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      operationType: TopupOperation.credit,
      reference: 'tp-1',
      requestPayload: { topupId: 'tp-1', ownerId: OWNER, currency: CURRENCY, amount: '1000' },
    });
  });

  it('credits payout available from the external collection account in one entry', async () => {
    await service.credit(base);

    expect(ledger.lastOperation.entries).toHaveLength(1);
    expect(legs(ledger.lastOperation.entries[0])).toEqual([
      ['system:external:collection', 'debit', 1000n],
      ['payout:available', 'credit', 1000n],
    ]);
    expect(ledger.lastOperation.guardNegative).toEqual([]);
  });

  it('rejects a topup already credited under the same id, whatever the idempotency key', async () => {
    build({ netAmount: () => 1000n });

    await expect(service.credit({ ...base, idempotencyKey: 'key-2' })).rejects.toMatchObject({
      code: ErrorCode.TOPUP_ALREADY_CREDITED,
      details: { topupId: 'tp-1' },
    });
    expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
      'tp-1',
      expect.objectContaining({ walletType: 'payout', accountType: 'available' }),
      [TopupOperation.credit],
    );
  });

  it('returns the ids and the payout wallet balance', async () => {
    await expect(service.credit(base)).resolves.toEqual({
      operationId: ledger.operationId,
      entryId: 'entry-1',
      topupId: 'tp-1',
      balance: expect.objectContaining({ walletType: 'payout' }),
    });
    expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'payout');
  });

  it('emits a single TopupCredited event', async () => {
    await service.credit(base);

    expect(ledger.events).toEqual([
      {
        type: OutboxEventType.TOPUP_CREDITED,
        schemaVersion: 1,
        payload: expect.objectContaining({
          operationId: ledger.operationId,
          topupId: 'tp-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '1000',
          balance: expect.objectContaining({ walletType: 'payout' }),
        }),
      },
    ]);
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.credit({ ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
