import { LienOperation, LiensService } from '../../../src/liens/liens.service';
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
  idempotencyKey: 'LIEN-1',
  lienId: 'LIEN-1',
  ownerId: OWNER,
  walletType: 'payout' as const,
  currency: CURRENCY,
  amount: 400n,
};

/** Renders a posting as [account label, direction, amount] for readable assertions. */
const label = (account: AccountRef): string =>
  account.kind === 'user' ? `${account.walletType}:${account.accountType}` : `system:${account.name}`;

const legs = (entry: { postings: { account: AccountRef; direction: string; amount: bigint }[] }) =>
  entry.postings.map((p) => [label(p.account), p.direction, p.amount]);

describe('LiensService', () => {
  let ledger: LedgerHarness;
  let service: LiensService;

  const build = (options: LedgerHarnessOptions = {}) => {
    ledger = new LedgerHarness(options);
    service = new LiensService(ledger.service, mockCurrencyRegistry({ known: [CURRENCY] }).asService);
    return service;
  };

  beforeEach(() => build());

  describe('place', () => {
    it('posts under lien.place, referenced by the lien id', async () => {
      await service.apply('place', base);

      expect(ledger.lastCall).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: 'LIEN-1',
        operationType: LienOperation.place,
        reference: 'LIEN-1',
        requestPayload: { lienId: 'LIEN-1', ownerId: OWNER, walletType: 'payout', currency: CURRENCY, amount: '400' },
      });
    });

    it('moves the amount from available into the lien account of that wallet', async () => {
      await service.apply('place', base);

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['payout:available', 'debit', 400n],
        ['payout:lien', 'credit', 400n],
      ]);
    });

    it('replaces a smaller lien by moving only the difference out of available', async () => {
      build({ balance: () => walletBalance({ available: 1000n, lien: 150n }) });

      await service.apply('place', base);

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['payout:available', 'debit', 250n],
        ['payout:lien', 'credit', 250n],
      ]);
      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['payout:available']);
      expect(ledger.events[0].payload).toMatchObject({ amount: '400', previousLien: '150' });
    });

    it('replaces a larger lien by handing the difference back to available', async () => {
      build({ balance: () => walletBalance({ available: 100n, lien: 700n }) });

      await service.apply('place', base);

      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['payout:lien', 'debit', 300n],
        ['payout:available', 'credit', 300n],
      ]);
      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['payout:lien']);
    });

    it('posts nothing when the lien already equals the amount', async () => {
      build({ balance: () => walletBalance({ available: 100n, lien: 400n }) });

      await expect(service.apply('place', base)).resolves.toMatchObject({ entryId: null, lienId: 'LIEN-1' });
      expect(ledger.lastOperation.entries).toEqual([]);
      expect(ledger.lastOperation.guardNegative).toEqual([]);
    });

    it('guards available, so a lien cannot exceed the spendable balance', async () => {
      await service.apply('place', { ...base, walletType: 'collection' });

      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['collection:available']);
    });

    it('rejects a lien id that has already been placed', async () => {
      build({ netAmount: () => 400n });

      await expect(service.apply('place', base)).rejects.toMatchObject({
        code: ErrorCode.LIEN_ALREADY_PLACED,
        details: { lienId: 'LIEN-1' },
      });
      expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
        'LIEN-1',
        expect.objectContaining({ walletType: 'payout', accountType: 'lien' }),
        [LienOperation.place],
      );
    });

    it('returns the ids and the balance of the liened wallet', async () => {
      await expect(service.apply('place', base)).resolves.toEqual({
        operationId: ledger.operationId,
        entryId: 'entry-1',
        lienId: 'LIEN-1',
        balance: expect.objectContaining({ walletType: 'payout' }),
      });
      expect(ledger.accountBalance).toHaveBeenCalledWith(OWNER, CURRENCY, 'payout');
    });

    it('emits LienPlaced', async () => {
      await service.apply('place', base);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.LIEN_PLACED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            lienId: 'LIEN-1',
            ownerId: OWNER,
            walletType: 'payout',
            currency: CURRENCY,
            amount: '400',
          }),
        },
      ]);
    });
  });

  describe('release', () => {
    const release = { ...base, lienId: 'LIEN-2', idempotencyKey: 'LIEN-2' };

    it('moves the amount from the lien account back to available', async () => {
      await service.apply('release', release);

      expect(ledger.lastCall).toMatchObject({ operationType: LienOperation.release, reference: 'LIEN-2' });
      expect(legs(ledger.lastOperation.entries[0])).toEqual([
        ['payout:lien', 'debit', 400n],
        ['payout:available', 'credit', 400n],
      ]);
    });

    it('guards the lien account, so it cannot release more than is held', async () => {
      await service.apply('release', release);

      expect(ledger.lastOperation.guardNegative?.map(label)).toEqual(['payout:lien']);
    });

    it('rejects a lien id that has already been released', async () => {
      build({ netAmount: () => 400n });

      await expect(service.apply('release', release)).rejects.toMatchObject({
        code: ErrorCode.LIEN_ALREADY_RELEASED,
      });
      expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
        'LIEN-2',
        expect.objectContaining({ accountType: 'available' }),
        [LienOperation.release],
      );
    });

    it('emits LienReleased', async () => {
      await service.apply('release', release);

      expect(ledger.events.map((e) => e.type)).toEqual([OutboxEventType.LIEN_RELEASED]);
    });
  });

  it('rejects an unknown currency before reaching the ledger', async () => {
    await expect(service.apply('place', { ...base, currency: 'XXX' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
