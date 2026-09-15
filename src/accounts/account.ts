import { Types } from "mongoose";

export const USER_ACCOUNT_TYPES = ['available', 'held-inflow', 'held-outflow', 'reserve', 'refund-chargeback'] as const;
export type UserAccountTpe = (typeof USER_ACCOUNT_TYPES)[number];

export const WALLET_TYPES = ['collection', 'payout'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export type AccountKind = 'user' | 'system';

export interface AccountDoc {
  _id: string;
  tenantId: string;
  ownerId: string | null;
  currency: string;
  walletType: WalletType | null;
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
  walletType: WalletType,
  accountType: UserAccountTpe
): string {
  return `${tenantId}:user:${ownerId}:${currency}:${walletType}:${accountType}`
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
  | { kind: 'user'; ownerId: string; currency: string; walletType: WalletType; accountType: UserAccountTpe }
  | { kind: 'system'; name: string; currency: string }

export const accountRef = {
  userAvailable: (ownerId: string, currency: string, walletType: WalletType): AccountRef => ({
    kind: 'user',
    ownerId, currency, walletType, accountType: 'available'
  }),
  user: (
    ownerId: string,
    currency: string,
    walletType: WalletType,
    accountType: UserAccountTpe
  ): AccountRef => ({
    kind: 'user',
    ownerId,
    currency,
    walletType,
    accountType
  }),
  collectionWallet: (ownerId: string, currency: string, accountType: UserAccountTpe): AccountRef => ({
    kind: 'user',
    ownerId, currency, walletType: 'collection', accountType
  }),
  payoutWallet: (ownerId: string, currency: string, accountType: UserAccountTpe): AccountRef => ({
    kind: 'user',
    ownerId, currency, walletType: 'payout', accountType
  }),
  system: (name: string, currency: string): AccountRef => ({
    kind: 'system', name, currency
  }),
  systemCollection: (currency: string): AccountRef => ({
    kind: 'system',
    name: System.collection,
    currency
  }),
  systemPayout: (currency: string): AccountRef => ({
    kind: 'system',
    name: System.payout,
    currency
  })
}
