import { Types } from 'mongoose';
import { AccountDoc, WalletType } from '../../src/accounts/account';
import { WalletBalance } from '../../src/wallets/dto';
import { Currency } from '../../src/currency/currency';

export const TENANT = 't1';
export const OWNER = 'm1';
export const CURRENCY = 'NGN';

export const NGN: Currency = { code: 'NGN', scale: 2, type: 'fiat' };

/** A wallet balance with every bucket at zero; override only what a test cares about.
 * `ledger` is recomputed so the fixture stays internally consistent. */
export function walletBalance(overrides: Partial<WalletBalance> = {}): WalletBalance {
  const base: WalletBalance = {
    tenantId: TENANT,
    ownerId: OWNER,
    currency: CURRENCY,
    walletType: 'collection',
    available: 0n,
    heldInflow: 0n,
    heldOutflow: 0n,
    reserve: 0n,
    ledger: 0n,
    refundChargeback: 0n,
    ...overrides,
  };
  return {
    ...base,
    ledger: overrides.ledger ?? base.available + base.heldInflow + base.heldOutflow + base.reserve,
  };
}

export function accountDoc(overrides: Partial<AccountDoc> = {}): AccountDoc {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    ownerId: OWNER,
    currency: CURRENCY,
    walletType: 'collection' as WalletType,
    accountType: 'available',
    kind: 'user',
    balance: Types.Decimal128.fromString('0'),
    version: 0,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A user sub-account doc carrying `balance` minor units. */
export function userAccount(
  accountType: string,
  balance: bigint,
  overrides: Partial<AccountDoc> = {},
): AccountDoc {
  return accountDoc({
    accountType,
    balance: Types.Decimal128.fromString(balance.toString()),
    ...overrides,
  });
}
