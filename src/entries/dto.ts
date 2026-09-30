import z from "zod";
import type { AccountKind, WalletType } from "../accounts/account";
import { fromDecimal128 } from "../common/money";
import { CollectionOperation } from "../collections/collection.service";
import { ConversionOperation } from "../conversions/conversion-transitions";
import { PayoutOperation } from "../payouts/payout-transitions";
import { SettlementOperation } from "../settlements/settlement-transitions";
import { WALLET_TRANSFER_OPERATION } from "../wallets/wallets.service";
import type { Direction, EntryDoc, PostingDoc } from "../ledger/types";

export const REFERENCE_OPERATION_TYPES = {
  collectionId: Object.values(CollectionOperation),
  payoutId: Object.values(PayoutOperation),
  settlementId: Object.values(SettlementOperation),
  conversionId: Object.values(ConversionOperation),
  IntraTransferId: [WALLET_TRANSFER_OPERATION],
} as const satisfies Record<string, readonly string[]>;

export type ReferenceKey = keyof typeof REFERENCE_OPERATION_TYPES;
const REFERENCE_KEYS = Object.keys(REFERENCE_OPERATION_TYPES) as ReferenceKey[];
const LOOKUP_KEYS = ['idempotencyKey', ...REFERENCE_KEYS] as const;

export type EntryLookup =
  | { by: 'idempotencyKey'; value: string }
  | { by: ReferenceKey; value: string };

export const entryLookupSchema = z
  .object(Object.fromEntries(LOOKUP_KEYS.map((k) => [k, z.string().min(1).optional()])) as Record<
    (typeof LOOKUP_KEYS)[number],
    z.ZodOptional<z.ZodString>
  >)
  .transform((q, ctx): EntryLookup => {
    const given = LOOKUP_KEYS.filter((k) => q[k] !== undefined);
    if (given.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `Provide exactly one of: ${LOOKUP_KEYS.join(', ')}`,
        path: given.length > 1 ? [given[1]] : [],
      });
      return z.NEVER;
    }
    const [by] = given;
    return { by, value: q[by]! } as EntryLookup;
  });
export type EntryLookupDto = z.infer<typeof entryLookupSchema>;

export interface EntryPostingView {
  postingId: string;
  kind: AccountKind;
  ownerId: string | null;
  walletType: WalletType | null;
  accountType: string;
  direction: Direction;
  amount: string;
  balanceAfter: string | null;
  sequence: number | null;
}

export interface EntryView {
  entryId: string;
  operationId: string;
  operationType: string;
  reference: string | null;
  currency: string;
  reversalOf: string | null;
  metadata: Record<string, unknown> | null;
  actor: string | null;
  createdAt: string;
  postings: EntryPostingView[];
}

export interface EntryList {
  items: EntryView[];
}

export function entryView(entry: EntryDoc, postings: PostingDoc[]): EntryView {
  return {
    entryId: entry._id.toHexString(),
    operationId: entry.operationId.toHexString(),
    operationType: entry.operationType,
    reference: entry.reference,
    currency: entry.currency,
    reversalOf: entry.reversalOf ? entry.reversalOf.toHexString() : null,
    metadata: entry.metadata,
    actor: entry.actor,
    createdAt: entry.createdAt.toISOString(),
    postings: postings.map((p) => ({
      postingId: p._id.toHexString(),
      kind: p.kind,
      ownerId: p.ownerId,
      walletType: p.walletType,
      accountType: p.accountType,
      direction: p.direction,
      amount: fromDecimal128(p.amount).toString(),
      balanceAfter: p.balanceAfter ? fromDecimal128(p.balanceAfter).toString() : null,
      sequence: p.sequence,
    })),
  };
}
