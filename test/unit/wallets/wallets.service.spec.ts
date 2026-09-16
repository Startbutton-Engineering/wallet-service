import { WalletsService, WALLET_TRANSFER_OPERATION } from '../../../src/wallets/wallets.service';
import { OutboxEventType } from '../../../src/ledger/types';
import { ErrorCode } from '../../../src/common/errors';
import { accountRef, refKey } from '../../../src/accounts/account';
import {
  CURRENCY,
  OWNER,
  TENANT,
  LedgerHarness,
  mockAccountsRepository,
  mockCurrencyRegistry,
  walletBalance,
} from '../../mocks';

const params = {
  tenantId: TENANT,
  idempotencyKey: 'key-1',
  transferId: 'tr-1',
  ownerId: OWNER,
  currency: CURRENCY,
  amount: 1000n,
  from: 'collection' as const,
  to: 'payout' as const,
};

const accountKeyOf = (ref: any) => refKey(ref);

describe('WalletsService', () => {
  let currencies: ReturnType<typeof mockCurrencyRegistry>;
  let accounts: ReturnType<typeof mockAccountsRepository>;
  let ledger: LedgerHarness;
  let service: WalletsService;

  const build = (
    balanceBreakdown?: Parameters<typeof mockAccountsRepository>[0],
    ledgerHarness = new LedgerHarness(),
  ) => {
    currencies = mockCurrencyRegistry({ known: [CURRENCY] });
    accounts = mockAccountsRepository(balanceBreakdown);
    ledger = ledgerHarness;
    service = new WalletsService(currencies.asService, accounts.asRepository, ledger.service);
    return service;
  };

  beforeEach(() => build());

  describe('createWallet', () => {
    it('provisions the wallet and returns its fresh balance', async () => {
      build((tenantId, ownerId, currency, walletType) =>
        walletBalance({ tenantId, ownerId, currency, walletType }),
      );

      await expect(service.createWallet(TENANT, OWNER, CURRENCY, 'payout')).resolves.toMatchObject({
        ownerId: OWNER,
        walletType: 'payout',
        available: 0n,
        ledger: 0n,
      });
      expect(accounts.ensureUserWallet).toHaveBeenCalledWith(TENANT, OWNER, CURRENCY, 'payout');
    });

    it('rejects an unknown currency before touching the accounts', async () => {
      await expect(service.createWallet(TENANT, OWNER, 'XXX', 'collection')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
      expect(accounts.ensureUserWallet).not.toHaveBeenCalled();
    });
  });

  describe('walletBalance', () => {
    it('returns the breakdown for a provisioned wallet', async () => {
      build(() => walletBalance({ available: 400n }));
      await expect(service.walletBalance(TENANT, OWNER, CURRENCY, 'collection')).resolves.toMatchObject({
        available: 400n,
      });
    });

    it('404s for a wallet that was never provisioned', async () => {
      await expect(service.walletBalance(TENANT, OWNER, CURRENCY, 'payout')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        message: `No payout wallet for owner ${OWNER} in ${CURRENCY}`,
        details: { ownerId: OWNER, currency: CURRENCY, walletType: 'payout' },
      });
    });

    it('rejects an unknown currency', async () => {
      await expect(service.walletBalance(TENANT, OWNER, 'XXX', 'collection')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
    });
  });

  describe('balances', () => {
    it('returns every provisioned wallet in WALLET_TYPES order', async () => {
      build((_t, _o, _c, walletType) => walletBalance({ walletType }));

      await expect(service.balances(TENANT, OWNER, CURRENCY)).resolves.toMatchObject([
        { walletType: 'collection' },
        { walletType: 'payout' },
      ]);
    });

    it('omits a wallet type the owner was never provisioned for', async () => {
      build((_t, _o, _c, walletType) => (walletType === 'payout' ? walletBalance({ walletType }) : null));

      const balances = await service.balances(TENANT, OWNER, CURRENCY);
      expect(balances.map((b) => b.walletType)).toEqual(['payout']);
    });

    it('404s only when the owner holds no wallet at all in the currency', async () => {
      await expect(service.balances(TENANT, OWNER, CURRENCY)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        message: `No wallet for owner ${OWNER} in ${CURRENCY}`,
        details: { ownerId: OWNER, currency: CURRENCY },
      });
    });

    it('rejects an unknown currency', async () => {
      await expect(service.balances(TENANT, OWNER, 'XXX')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
    });
  });

  describe('transfer', () => {
    it('posts one balanced entry moving available between the two wallets', async () => {
      await service.transfer(params);

      const [entry] = ledger.lastOperation.entries;
      expect(entry.currency).toBe(CURRENCY);
      expect(entry.postings.map((p) => [accountKeyOf(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.user(OWNER, CURRENCY, 'collection', 'available')), 'debit', 1000n],
        [refKey(accountRef.user(OWNER, CURRENCY, 'payout', 'available')), 'credit', 1000n],
      ]);
    });

    it('guards only the source wallet against going negative', async () => {
      await service.transfer(params);

      expect(ledger.lastOperation.guardNegative?.map(accountKeyOf)).toEqual([
        refKey(accountRef.user(OWNER, CURRENCY, 'collection', 'available')),
      ]);
    });

    it('posts under the wallet-transfer operation, keyed on the transfer id', async () => {
      await service.transfer(params);

      expect(ledger.lastCall).toMatchObject({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        operationType: WALLET_TRANSFER_OPERATION,
        reference: 'tr-1',
        requestPayload: {
          transferId: 'tr-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '1000',
          from: 'collection',
          to: 'payout',
        },
      });
    });

    it('returns both wallet balances alongside the ids', async () => {
      await expect(service.transfer(params)).resolves.toEqual({
        operationId: ledger.operationId,
        entryId: 'entry-1',
        transferId: 'tr-1',
        from: 'collection',
        to: 'payout',
        source: expect.objectContaining({ walletType: 'collection' }),
        destination: expect.objectContaining({ walletType: 'payout' }),
      });
    });

    it('emits a WalletTransferred event carrying both balances', async () => {
      await service.transfer(params);

      expect(ledger.events).toEqual([
        {
          type: OutboxEventType.WALLET_TRANSFERRED,
          schemaVersion: 1,
          payload: expect.objectContaining({
            operationId: ledger.operationId,
            transferId: 'tr-1',
            ownerId: OWNER,
            currency: CURRENCY,
            amount: '1000',
            from: 'collection',
            to: 'payout',
          }),
        },
      ]);
    });

    it('checks the destination for this transfer id before posting anything', async () => {
      await service.transfer(params);

      expect(ledger.referenceNetAmount).toHaveBeenCalledWith(
        'tr-1',
        expect.objectContaining({ walletType: 'payout', accountType: 'available' }),
        [WALLET_TRANSFER_OPERATION],
      );
    });

    it('rejects replaying a transfer id that already moved funds', async () => {
      build(undefined, new LedgerHarness({ netAmount: () => 1000n }));

      await expect(service.transfer(params)).rejects.toMatchObject({
        code: ErrorCode.WALLET_TRANSFER_ALREADY_APPLIED,
        details: { transferId: 'tr-1' },
      });
    });

    it('rejects an unknown currency before reaching the ledger', async () => {
      await expect(service.transfer({ ...params, currency: 'XXX' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
      });
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('moves funds back the other way just as readily', async () => {
      await service.transfer({ ...params, from: 'payout', to: 'collection' });

      const [entry] = ledger.lastOperation.entries;
      expect(entry.postings.map((p) => [(p.account as any).walletType, p.direction])).toEqual([
        ['payout', 'debit'],
        ['collection', 'credit'],
      ]);
    });
  });
});
