import { Types } from 'mongoose';
import {
  accountsFromLegacy,
  legacyFieldsFromBalance,
  LegacyWalletsService,
  majorToMinor,
  minorToMajor,
} from '../../../src/ledger/legacy-wallets.service';
import { loadConfig } from '../../../src/config';
import { mockSession } from '../../mocks/mongoose.mock';
import { mockAccountsRepository } from '../../mocks/ledger.mock';
import { walletBalance } from '../../mocks/fixtures';

describe('majorToMinor', () => {
  it.each([
    [100.5, 2, 10050n],
    [-250.75, 2, -25075n],
    [0.1 + 0.2, 2, 30n],
    [0.1 + 0.2, 10, 3000000000n],
    [5000, 0, 5000n],
    [undefined, 2, 0n],
    [null, 2, 0n],
    ['12.5', 2, 1250n],
  ])('converts %s at scale %s to %s', (amount, scale, expected) => {
    expect(majorToMinor(amount, scale)).toBe(expected);
  });

  it('refuses a value that is not a finite number', () => {
    expect(() => majorToMinor(Number.NaN, 2)).toThrow('not a finite number');
    expect(() => majorToMinor('abc', 2)).toThrow('not a finite number');
  });
});

describe('minorToMajor', () => {
  it.each([
    [10050n, 2, 100.5],
    [-25075n, 2, -250.75],
    [5n, 2, 0.05],
    [0n, 2, 0],
    [5000n, 0, 5000],
    [3000000000n, 10, 0.3],
  ])('converts %s at scale %s to %s', (minor, scale, expected) => {
    expect(minorToMajor(minor, scale)).toBe(expected);
  });
});

describe('accountsFromLegacy and legacyFieldsFromBalance', () => {
  const legacy = {
    availableBalance: 5100.25,
    ledgerBalance: 6300,
    lienBalance: 500,
    refundsOrChargeBackBalance: -3,
    rollingReserveOverdraftBalance: -2,
  };

  it('splits the lien out of available and parks ledger − available in legacy-pending', () => {
    expect(accountsFromLegacy(legacy, 2)).toEqual({
      available: 460025n,
      lien: 50000n,
      'legacy-pending': 119975n,
      'refund-chargeback': -300n,
      'reserve-overdraft': -200n,
    });
  });

  it('round-trips: the legacy document is written back exactly as it was migrated', () => {
    const accounts = accountsFromLegacy(legacy, 2);
    const balance = walletBalance({
      available: accounts.available,
      lien: accounts.lien,
      legacyPending: accounts['legacy-pending'],
      refundChargeback: accounts['refund-chargeback'],
      reserveOverdraft: accounts['reserve-overdraft'],
    });
    expect(legacyFieldsFromBalance(balance, 2)).toEqual(legacy);
  });

  it('counts native holds in the legacy ledger balance but not in available', () => {
    const balance = walletBalance({ available: 1000n, heldInflow: 200n, heldOutflow: 50n });
    expect(legacyFieldsFromBalance(balance, 2)).toMatchObject({ availableBalance: 10, ledgerBalance: 12.5 });
  });
});

describe('LegacyWalletsService', () => {
  const session = mockSession().asSession;
  const ownerId = new Types.ObjectId().toHexString();
  const legacyId = new Types.ObjectId();
  const wallet = { ownerId, currency: 'NGN', walletType: 'payout' as const };

  function setup({ legacyDbName = 'startbutton', found = { _id: legacyId } as unknown, balance = walletBalance({ available: 1050n, lien: 50n }) as unknown } = {}) {
    const findOne = jest.fn(async () => found);
    const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    const db = jest.fn(() => ({ collection: () => ({ findOne, updateOne }) }));
    const currencies = { require: jest.fn(async () => ({ code: 'NGN', scale: 2, type: 'fiat' })) };
    const service = new LegacyWalletsService(
      { conn: { getClient: () => ({ db }) } } as never,
      mockAccountsRepository(() => balance as never).asRepository,
      currencies as never,
      { ...loadConfig({} as NodeJS.ProcessEnv), legacyDbName },
    );
    return { service, findOne, updateOne, db };
  }

  it('refuses to reach the legacy database when it is not configured', () => {
    expect(() => setup({ legacyDbName: '' }).service.collection()).toThrow('LEGACY_DB_NAME is not configured');
  });

  it('finds the oldest ledger-processed legacy document of the wallet, with its scale', async () => {
    const { service, findOne, db } = setup();

    await expect(service.findLedgerProcessed(wallet, session)).resolves.toEqual({ _id: legacyId, scale: 2 });
    expect(db).toHaveBeenCalledWith('startbutton');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payout', currency: 'NGN', isLedgerProcessed: true }),
      expect.objectContaining({ session, sort: { createdAt: 1, _id: 1 } }),
    );
  });

  it('finds nothing without a legacy database, for an owner that is not a back-end merchant id, or with no ledger-processed document', async () => {
    await expect(setup({ legacyDbName: '' }).service.findLedgerProcessed(wallet)).resolves.toBeNull();
    await expect(setup().service.findLedgerProcessed({ ...wallet, ownerId: 'not-an-object-id' })).resolves.toBeNull();
    await expect(setup({ found: null }).service.findLedgerProcessed(wallet)).resolves.toBeNull();
  });

  it('tells whether an owner has been cut over', async () => {
    await expect(setup().service.isCutOver(ownerId)).resolves.toBe(true);
    await expect(setup({ found: null }).service.isCutOver(ownerId, session)).resolves.toBe(false);
  });

  it('updates each cut-over wallet once from its ledger balance', async () => {
    const { service, updateOne } = setup();

    await service.updateFromLedger('t1', [wallet, wallet], session);

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: legacyId },
      { $set: expect.objectContaining({ availableBalance: 11, ledgerBalance: 11, lienBalance: 0.5 }) },
      { session },
    );
  });

  it('leaves wallets that are not cut over alone', async () => {
    const { service, updateOne } = setup({ found: null });
    await service.updateFromLedger('t1', [wallet], session);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('fails the post when a cut-over wallet has no ledger accounts', async () => {
    await expect(setup({ balance: null }).service.updateFromLedger('t1', [wallet], session))
      .rejects.toMatchObject({ code: 'LEGACY_WALLET_UPDATE_FAILED' });
  });
});
