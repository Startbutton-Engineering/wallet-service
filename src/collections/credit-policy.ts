import { accountRef } from "../accounts/account";
import { EntryI } from "../ledger/types";

export const creditWithDebtPaydown = (params: {
  ownerId: string;
  currency: string;
  amount: bigint;
  refundChargeBackBalance: bigint;
}): { postings: EntryI['postings']; settled: bigint; amountToCredit: bigint } => {
  const { ownerId, currency, amount, refundChargeBackBalance } = params;
  const debt = refundChargeBackBalance < 0n ? -refundChargeBackBalance : 0n;
  const settled = amount < debt ? amount : debt;
  const amountToCredit = amount - settled;

  const postings: EntryI['postings'] = [];
  if (settled > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'refund-chargeback'),
      direction: 'credit',
      amount: settled
    })
  }
  if (amountToCredit > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'available'),
      direction: 'credit',
      amount: amountToCredit
    })
  }

  return { postings, settled, amountToCredit };
}

/** The debit half of the refund/chargeback debt: take what `available` can cover and, when the
 * caller allows an overdraft, book the shortfall as debt on `refund-chargeback` (which may go
 * negative). Without an overdraft the whole amount is debited from `available`, so the caller's
 * guardNegative on `available` rejects it with 422 instead of creating debt. */
export const debitWithOverdraft = (params: {
  ownerId: string;
  currency: string;
  amount: bigint;
  available: bigint;
  allowOverdraft: boolean;
}): { postings: EntryI['postings']; fromAvailable: bigint; deficit: bigint } => {
  const { ownerId, currency, amount, available, allowOverdraft } = params;
  const covered = available > 0n ? available : 0n;
  const fromAvailable = !allowOverdraft || amount < covered ? amount : covered;
  const deficit = amount - fromAvailable;

  const postings: EntryI['postings'] = [];
  if (fromAvailable > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'available'),
      direction: 'debit',
      amount: fromAvailable
    })
  }
  if (deficit > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'refund-chargeback'),
      direction: 'debit',
      amount: deficit
    })
  }

  return { postings, fromAvailable, deficit };
}

/** Undo a debitWithOverdraft: hand `amount` back, cancelling the debt it created first.
 * Any part of that debt already repaid by later credits was the owner's own money, so it goes
 * back to `available` rather than pushing `refund-chargeback` above zero. Not a new credit, so
 * it never pays down debt the reversed operation did not create. */
export const reverseOverdraftDebit = (params: {
  ownerId: string;
  currency: string;
  amount: bigint;
  deficit: bigint;
  refundChargeBackBalance: bigint;
}): { postings: EntryI['postings']; toDebt: bigint; toAvailable: bigint } => {
  const { ownerId, currency, amount, deficit, refundChargeBackBalance } = params;
  const outstandingDebt = refundChargeBackBalance < 0n ? -refundChargeBackBalance : 0n;
  const cap = deficit < amount ? deficit : amount;
  const toDebt = cap < outstandingDebt ? cap : outstandingDebt;
  const toAvailable = amount - toDebt;

  const postings: EntryI['postings'] = [];
  if (toDebt > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'refund-chargeback'),
      direction: 'credit',
      amount: toDebt
    })
  }
  if (toAvailable > 0n) {
    postings.push({
      account: accountRef.collectionWallet(ownerId, currency, 'available'),
      direction: 'credit',
      amount: toAvailable
    })
  }

  return { postings, toDebt, toAvailable };
}
