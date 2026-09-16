import { Types } from "mongoose";

export const USER_ACCOUNT_TYPES = ['available', 'held-inflow', 'held-outflow', 'reserve', 'refund-chargeback'] as const;
export type UserAccountTpe = (typeof USER_ACCOUNT_TYPES)[number];

export const WALLET_TYPES = ['collection', 'payout'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export type AccountKind = 'user' | 'system';

export interface AccountDoc {
  _id: Types.ObjectId;
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

/** In-memory map key for an AccountRef — never persisted. Scoped to one post() call,
 * which is always a single tenant (args.tenantId), so tenantId is deliberately absent.
 * `\0` cannot appear in any component, so the encoding is unambiguous even though
 * system names themselves contain colons (e.g. `external:collection`). */
export function refKey(ref: AccountRef): string {
  return ref.kind === 'user'
    ? `u\0${ref.ownerId}\0${ref.currency}\0${ref.walletType}\0${ref.accountType}`
    : `s\0${ref.name}\0${ref.currency}`;
}

/** The AccountRef a stored account document represents — the inverse of provisioning. */
export function refOf(doc: AccountDoc): AccountRef {
  return doc.kind === 'user'
    ? {
        kind: 'user',
        ownerId: doc.ownerId!,
        currency: doc.currency,
        walletType: doc.walletType!,
        accountType: doc.accountType as UserAccountTpe
      }
    : { kind: 'system', name: doc.accountType, currency: doc.currency };
}
