import { Types } from "mongoose";
import { AccountRef, WalletType } from "../accounts/account";

export type Direction = 'debit' | 'credit';

export interface PostingI {
  account: AccountRef;
  direction: Direction;
  amount: bigint;
}

/** A balanced group of postings in a single currency. Debits must equal credits */
export interface EntryI {
  currency: string;
  postings: PostingI[];
  /** Overrides PostArgs.reference for this entry only — lets one post() call tag several
   * entries with different references (e.g. one per collectionId in a batch settle). */
  reference?: string;
  /** Overrides PostArgs.operationType for this entry only. */
  operationType?: string;
  metadata?: Record<string, unknown>;
}

export function signedDelta(direction: Direction, amount: bigint): bigint {
  return direction === 'credit' ? amount : -amount;
}

export interface PostingDoc {
  _id: string;
  tenantId: string;
  operationId: string;
  entryId: string;
  accountId: string;
  ownerId: string | null;
  walletType: WalletType | null;
  currency: string;
  direction: Direction;
  amount: Types.Decimal128;
  balanceAfter: Types.Decimal128 | null;
  sequence: number | null;
  operationType: string;
  reference: string | null;
  actor: string | null;
  createdAt: Date;
}

export interface EntryDoc {
  _id: string;
  tenantId: string;
  operationId: string;
  currency: string;
  operationType: string;
  postingIds: string[];
  reference: string | null;
  actor: string | null;
  reversalOf: string | null;
  createdAt: Date;
}

export interface IdempotencyDoc {
  _id: string;
  tenantId: string;
  key: string;
  requestHash: string;
  operationType: string;
  status: 'completed';
  result: unknown;
  createdAt: Date;
}

export interface OutboxDoc {
  _id: string;
  tenantId: string;
  type: string;
  schemaVersion: number;
  dedupeId: string;
  operationId: string;
  payload: Record<string, unknown>;
  published: boolean;
  publishedAt: Date | null;
  createdAt: Date;
}

export interface OutboxEventI {
  type: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

export enum OutboxEventType {
  COLLECTION_RECEIVED = 'CollectionReceived',
  COLLECTION_SETTLED = 'CollectionSettled'
}