import { Types } from 'mongoose';
import {
  accountRef,
  refKey,
  refOf,
  System,
  USER_ACCOUNT_TYPES,
  WALLET_TYPES,
} from '../../../src/accounts/account';
import { accountDoc } from '../../mocks';

describe('refKey', () => {
  it('builds a key from every part of a user ref', () => {
    expect(refKey(accountRef.user('m1', 'NGN', 'collection', 'available'))).toBe(
      'u\0m1\0NGN\0collection\0available',
    );
  });

  it('keeps wallet types and account types apart', () => {
    expect(refKey(accountRef.user('m1', 'NGN', 'payout', 'held-outflow'))).toBe(
      'u\0m1\0NGN\0payout\0held-outflow',
    );
  });

  it('builds a system key without an owner or wallet type', () => {
    expect(refKey(accountRef.systemCollection('NGN'))).toBe('s\0external:collection\0NGN');
  });

  it('gives every account type a distinct key for one owner and wallet', () => {
    const keys = USER_ACCOUNT_TYPES.map((type) => refKey(accountRef.user('m1', 'NGN', 'collection', type)));
    expect(new Set(keys).size).toBe(USER_ACCOUNT_TYPES.length);
  });

  it('never collides a system name containing a colon with a user ref', () => {
    expect(refKey(accountRef.system('external:collection', 'NGN'))).not.toBe(
      refKey(accountRef.user('external', 'NGN', 'collection', 'available')),
    );
  });
});

describe('refOf', () => {
  it('round-trips a user account document back to its ref', () => {
    const ref = accountRef.user('m1', 'NGN', 'payout', 'reserve');
    const doc = accountDoc({
      kind: 'user',
      ownerId: 'm1',
      currency: 'NGN',
      walletType: 'payout',
      accountType: 'reserve',
    });

    expect(refOf(doc)).toEqual(ref);
    expect(refKey(refOf(doc))).toBe(refKey(ref));
  });

  it('round-trips a system account document back to its ref', () => {
    const ref = accountRef.systemCollection('NGN');
    const doc = accountDoc({
      _id: new Types.ObjectId(),
      kind: 'system',
      ownerId: null,
      walletType: null,
      accountType: System.collection,
      currency: 'NGN',
    });

    expect(refOf(doc)).toEqual(ref);
    expect(refKey(refOf(doc))).toBe(refKey(ref));
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
