import {
  accountRef,
  System,
  systemAccountId,
  USER_ACCOUNT_TYPES,
  userAccountId,
  WALLET_TYPES,
} from '../../../src/accounts/account';

describe('account ids', () => {
  it('builds a user account id from every part, in a fixed order', () => {
    expect(userAccountId('t1', 'm1', 'NGN', 'collection', 'available')).toBe(
      't1:user:m1:NGN:collection:available',
    );
  });

  it('keeps wallet types and account types apart in the id', () => {
    expect(userAccountId('t1', 'm1', 'NGN', 'payout', 'held-outflow')).toBe(
      't1:user:m1:NGN:payout:held-outflow',
    );
  });

  it('builds a system account id without an owner or wallet type', () => {
    expect(systemAccountId('t1', System.collection, 'NGN')).toBe('t1:system:external:collection:NGN');
  });

  it('gives every account type a distinct id for one owner and wallet', () => {
    const ids = USER_ACCOUNT_TYPES.map((type) => userAccountId('t1', 'm1', 'NGN', 'collection', type));
    expect(new Set(ids).size).toBe(USER_ACCOUNT_TYPES.length);
  });

  it('keeps tenants apart', () => {
    expect(userAccountId('t1', 'm1', 'NGN', 'collection', 'available')).not.toBe(
      userAccountId('t2', 'm1', 'NGN', 'collection', 'available'),
    );
  });
});

describe('System account names', () => {
  it('names the fixed external accounts', () => {
    expect(System.collection).toBe('external:collection');
    expect(System.payout).toBe('external:payout');
    expect(System.openingBalance).toBe('external:opening-balance');
    expect(System.suspenseRefunds).toBe('suspense:refunds');
  });

  it('derives an fx account name per currency', () => {
    expect(System.fx('NGN')).toBe('fx:NGN');
  });
});

describe('accountRef', () => {
  it('userAvailable points at the available sub-account of the given wallet', () => {
    expect(accountRef.userAvailable('m1', 'NGN', 'payout')).toEqual({
      kind: 'user',
      ownerId: 'm1',
      currency: 'NGN',
      walletType: 'payout',
      accountType: 'available',
    });
  });

  it('user takes the account type verbatim', () => {
    expect(accountRef.user('m1', 'NGN', 'collection', 'reserve')).toEqual({
      kind: 'user',
      ownerId: 'm1',
      currency: 'NGN',
      walletType: 'collection',
      accountType: 'reserve',
    });
  });

  it('collectionWallet and payoutWallet pin the wallet type', () => {
    expect(accountRef.collectionWallet('m1', 'NGN', 'held-inflow')).toMatchObject({
      walletType: 'collection',
      accountType: 'held-inflow',
    });
    expect(accountRef.payoutWallet('m1', 'NGN', 'held-outflow')).toMatchObject({
      walletType: 'payout',
      accountType: 'held-outflow',
    });
  });

  it('system refs carry a name and currency only', () => {
    expect(accountRef.system('fx:NGN', 'NGN')).toEqual({ kind: 'system', name: 'fx:NGN', currency: 'NGN' });
    expect(accountRef.systemCollection('NGN')).toEqual({
      kind: 'system',
      name: System.collection,
      currency: 'NGN',
    });
    expect(accountRef.systemPayout('NGN')).toEqual({
      kind: 'system',
      name: System.payout,
      currency: 'NGN',
    });
  });
});

describe('type constants', () => {
  it('lists the five user sub-accounts and the two wallet types', () => {
    expect(USER_ACCOUNT_TYPES).toEqual([
      'available',
      'held-inflow',
      'held-outflow',
      'reserve',
      'refund-chargeback',
    ]);
    expect(WALLET_TYPES).toEqual(['collection', 'payout']);
  });
});
