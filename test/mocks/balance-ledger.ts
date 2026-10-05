import { AccountRef, accountRef, refKey, WalletType } from '../../src/accounts/account';
import { PrePostContext } from '../../src/ledger/ledger.service';
import { Direction, EntryI, signedDelta } from '../../src/ledger/types';
import { walletBalance } from './fixtures';

interface FakePosting {
  reference: string;
  accountKey: string;
  operationType: string;
  direction: Direction;
  amount: bigint;
}

export class BalanceLedger {
  private postings: FakePosting[] = [];
  private entries: { id: string; reference: string; operationType: string }[] = [];
  private balances = new Map<string, bigint>();

  readonly ctx = {
    session: undefined as never,
    readBalance: async (ownerId: string, currency: string, walletType: WalletType) => {
      const of = (type: 'available' | 'held-inflow' | 'held-outflow' | 'refund-chargeback') =>
        this.balanceOf(accountRef.user(ownerId, currency, walletType, type));
      return walletBalance({
        ownerId,
        currency,
        walletType,
        available: of('available'),
        heldInflow: of('held-inflow'),
        heldOutflow: of('held-outflow'),
        refundChargeback: of('refund-chargeback'),
      });
    },
    referenceNetAmount: async (reference: string, account: AccountRef, operationTypes?: string[]) => {
      const key = refKey(account);
      return this.postings
        .filter((p) => p.reference === reference && p.accountKey === key)
        .filter((p) => !operationTypes || operationTypes.includes(p.operationType))
        .reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
    },
    referenceEntryIds: async (reference: string, operationType: string) =>
      this.entries
        .filter((e) => e.reference === reference && e.operationType === operationType)
        .map((e) => e.id),
  } satisfies PrePostContext;

  balanceOf(account: AccountRef): bigint {
    return this.balances.get(refKey(account)) ?? 0n;
  }

  /** Seed an account without going through a plan, e.g. funds already in `available`. */
  seed(account: AccountRef, balance: bigint): void {
    this.balances.set(refKey(account), balance);
  }

  /** Record a plan's entries under `reference`; returns the id given to the entry. */
  record(reference: string, operationType: string, entries: EntryI[]): string {
    const entryId = `entry-${this.entries.length + 1}`;
    this.entries.push({ id: entryId, reference, operationType });
    for (const entry of entries) {
      for (const posting of entry.postings) {
        const key = refKey(posting.account);
        this.balances.set(key, (this.balances.get(key) ?? 0n) + signedDelta(posting.direction, posting.amount));
        this.postings.push({
          reference,
          accountKey: key,
          operationType,
          direction: posting.direction,
          amount: posting.amount,
        });
      }
    }
    return entryId;
  }
}
