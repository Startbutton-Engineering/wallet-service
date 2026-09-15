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