import { Decimal128 } from "mongodb";

export const USER_ACCOUNT_TYPES = ['available', 'held-inflow', 'held-outflow', 'reserve', 'refund-chargeback'] as const;
export type UserAccountTpe = (typeof USER_ACCOUNT_TYPES)[number];

export type AccountKind = 'user' | 'system';

export interface AccountDoc {
  _id: string;
  ownerId: string | null;
  currency: string;
  accountType: string;
  kind: AccountKind;
  balance: Decimal128;
  version: number;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
}

export function userAccountId(
  tenantId: string,
  ownerId: string,
  currency: string,
  accountType: UserAccountTpe
): string {
  return `${tenantId}:user:${ownerId}:${currency}:${accountType}`
}

export function systemAccountId(
  tenantId: string,
  name: string,
  currency: string
): string {
  return `${tenantId}:system:${name}:${currency}`
}

/** System account names */
export const System = {
  funding: 'external:funding',
  payout: 'external:payout',
  openingBalance: 'external:opening-balance',
  fx: (currency: string) => `fx:${currency}`,
  suspenseRefunds: 'suspense:refunds'
} as const;