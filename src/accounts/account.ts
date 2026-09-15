import { Types } from "mongoose";

export const USER_ACCOUNT_TYPES = ['available', 'held-inflow', 'held-outflow', 'reserve', 'refund-chargeback'] as const;
export type UserAccountTpe = (typeof USER_ACCOUNT_TYPES)[number];

export type AccountKind = 'user' | 'system';

export interface AccountDoc {
  _id: string;
  tenantId: string;
  ownerId: string | null;
  currency: string;
  accountType: string;
  kind: AccountKind;
  balance: Types.Decimal128;
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
  collection: 'external:collection',
  payout: 'external:payout',
  openingBalance: 'external:opening-balance',
  fx: (currency: string) => `fx:${currency}`,
  suspenseRefunds: 'suspense:refunds'
} as const;

/** A reference to an account */
export type AccountRef = 
  | { kind: 'user'; ownerId: string; currency: string; accountType: UserAccountTpe }
  | { kind: 'system'; name: string; currency: string }

export const accountRef = {
  userAvailable: (ownerId: string, currency: string): AccountRef => ({
    kind: 'user',
    ownerId, currency, accountType: 'available'
  }),
  user: (ownerId: string, currency: string, accountType: UserAccountTpe): AccountRef => ({
    kind: 'user',
    ownerId,
    currency,
    accountType
  }),
  system: (name: string, currency: string): AccountRef => ({
    kind: 'system', name, currency
  }),
  collection: (currency: string): AccountRef => ({
    kind: 'system',
    name: System.collection,
    currency
  })
}