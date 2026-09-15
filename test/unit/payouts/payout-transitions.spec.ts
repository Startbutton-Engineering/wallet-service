import { AccountRef, systemAccountId, userAccountId } from "../../../src/accounts/account";
import { AppError, ErrorCode } from "../../../src/common/errors";
import { PrePostContext } from "../../../src/ledger/ledger.service";
import { Direction, signedDelta } from "../../../src/ledger/types";
import {
  PAYOUT_TRANSITIONS,
  PayoutStatus,
  TransitionParams,
} from "../../../src/payouts/payout-transitions";

const TENANT = 't1';
const PARAMS: TransitionParams = {
  payoutId: 'po-1',
  ownerId: 'm1',
  currency: 'NGN',
  amount: 10_500n,
};

interface FakePosting {
  reference: string;
  accountId: string;
  operationType: string;
  direction: Direction;
  amount: bigint;
}

function accountId(ref: AccountRef): string {
  return ref.kind === 'user'
    ? userAccountId(TENANT, ref.ownerId, ref.currency, ref.walletType, ref.accountType)
    : systemAccountId(TENANT, ref.name, ref.currency);
}

/** An in-memory stand-in for the posting log the real PrePostContext reads. Transitions are
 * applied in sequence against it, so the guards are exercised the same way they are in Mongo —
 * by summing what earlier transitions wrote. */
class FakeLedger {
  private postings: FakePosting[] = [];
  private entries: { id: string; reference: string; operationType: string }[] = [];

  readonly ctx = {
    session: undefined as never,
    readBalance: () => { throw new Error('not used by payout transitions') },
    referenceNetAmount: async (reference: string, account: AccountRef, operationTypes?: string[]) => {
      const id = accountId(account);
      return this.postings
        .filter((p) => p.reference === reference && p.accountId === id)
        .filter((p) => !operationTypes || operationTypes.includes(p.operationType))
        .reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
    },
    referenceEntryIds: async (reference: string, operationType: string) =>
      this.entries
        .filter((e) => e.reference === reference && e.operationType === operationType)
        .map((e) => e.id),
  } satisfies PrePostContext;

  async apply(status: PayoutStatus, params: TransitionParams = PARAMS): Promise<string> {
    const transition = PAYOUT_TRANSITIONS[status];
    const plan = await transition.plan(this.ctx, params);

    const entryId = `entry-${this.entries.length + 1}`;
    this.entries.push({ id: entryId, reference: params.payoutId, operationType: transition.operationType });
    for (const entry of plan.entries) {
      for (const posting of entry.postings) {
        this.postings.push({
          reference: params.payoutId,
          accountId: accountId(posting.account),
          operationType: transition.operationType,
          direction: posting.direction,
          amount: posting.amount,
        });
      }
    }
    return entryId;
  }

  async planOnly(status: PayoutStatus, params: TransitionParams = PARAMS) {
    return PAYOUT_TRANSITIONS[status].plan(this.ctx, params);
  }
}

async function codeOf(run: Promise<unknown>): Promise<ErrorCode> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
  throw new Error('expected the transition to be rejected');
}

describe('payout transitions', () => {
  let ledger: FakeLedger;

  beforeEach(() => {
    ledger = new FakeLedger();
  });

  describe('postings', () => {
    it('initiate moves available into held-outflow and guards available', async () => {
      const plan = await ledger.planOnly('initiated');
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'), 'debit', 10_500n],
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'held-outflow'), 'credit', 10_500n],
      ]);
      expect(plan.guardNegative.map(accountId)).toEqual([
        userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'),
      ]);
    });

    it('success moves held-outflow to the external payout account', async () => {
      await ledger.apply('initiated');
      const plan = await ledger.planOnly('success');
      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'held-outflow'), 'debit'],
        [systemAccountId(TENANT, 'external:payout', 'NGN'), 'credit'],
      ]);
    });

    it('failure returns held-outflow to available', async () => {
      await ledger.apply('initiated');
      const plan = await ledger.planOnly('failed');
      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'held-outflow'), 'debit'],
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'), 'credit'],
      ]);
    });

    it('reversal moves the external payout account back to available and cites the success entry', async () => {
      await ledger.apply('initiated');
      const successEntry = await ledger.apply('success');
      const plan = await ledger.planOnly('reversed');

      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [systemAccountId(TENANT, 'external:payout', 'NGN'), 'debit'],
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'), 'credit'],
      ]);
      expect(plan.reversalOf).toBe(successEntry);
      expect(plan.guardNegative).toEqual([]);
    });

    it('reverse-failed takes available back out and guards it', async () => {
      await ledger.apply('initiated');
      await ledger.apply('failed');
      const plan = await ledger.planOnly('reverse-failed');

      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'), 'debit'],
        [systemAccountId(TENANT, 'external:payout', 'NGN'), 'credit'],
      ]);
      expect(plan.guardNegative.map(accountId)).toEqual([
        userAccountId(TENANT, 'm1', 'NGN', 'payout', 'available'),
      ]);
    });

    it('every entry is balanced along a full initiate -> success -> reverse -> reverse-failed run', async () => {
      const run: PayoutStatus[] = ['initiated', 'success', 'reversed', 'reverse-failed'];
      for (const status of run) {
        const plan = await ledger.planOnly(status);
        for (const entry of plan.entries) {
          const net = entry.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
          expect(net).toBe(0n);
          expect(entry.postings.every((posting) => posting.amount > 0n)).toBe(true);
        }
        await ledger.apply(status);
      }
    });
  });

  describe('preconditions', () => {
    it('rejects initiating the same payout twice', async () => {
      await ledger.apply('initiated');
      expect(await codeOf(ledger.planOnly('initiated'))).toBe(ErrorCode.PAYOUT_ALREADY_INITIATED);
    });

    it.each(['success', 'failed'] as PayoutStatus[])(
      'rejects %s for a payout that was never initiated',
      async (status) => {
        expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.PAYOUT_NOT_INITIATED);
      },
    );

    it.each(['success', 'failed'] as PayoutStatus[])(
      'rejects %s once the hold is already cleared',
      async (status) => {
        await ledger.apply('initiated');
        await ledger.apply('success');
        expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.PAYOUT_ALREADY_RESOLVED);
      },
    );

    it.each(['success', 'failed'] as PayoutStatus[])(
      'rejects %s for an amount other than the held amount',
      async (status) => {
        await ledger.apply('initiated');
        const wrong = { ...PARAMS, amount: 10_000n };
        expect(await codeOf(ledger.planOnly(status, wrong))).toBe(ErrorCode.PAYOUT_AMOUNT_MISMATCH);
      },
    );

    it('rejects reversing a payout that only ever failed', async () => {
      await ledger.apply('initiated');
      await ledger.apply('failed');
      expect(await codeOf(ledger.planOnly('reversed'))).toBe(ErrorCode.PAYOUT_NOT_SUCCESSFUL);
    });

    it('rejects reversing twice', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');
      await ledger.apply('reversed');
      expect(await codeOf(ledger.planOnly('reversed'))).toBe(ErrorCode.PAYOUT_NOT_SUCCESSFUL);
    });

    it('rejects reversing for the wrong amount', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');
      const wrong = { ...PARAMS, amount: 10_000n };
      expect(await codeOf(ledger.planOnly('reversed', wrong))).toBe(ErrorCode.PAYOUT_AMOUNT_MISMATCH);
    });

    it('rejects reverse-failed while the payout is still merely held', async () => {
      await ledger.apply('initiated');
      expect(await codeOf(ledger.planOnly('reverse-failed'))).toBe(ErrorCode.PAYOUT_NOT_REVERSED);
    });

    it('rejects reverse-failed on a payout that succeeded and was never reversed', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');
      expect(await codeOf(ledger.planOnly('reverse-failed'))).toBe(ErrorCode.PAYOUT_NOT_REVERSED);
    });

    it('rejects reverse-failed twice', async () => {
      await ledger.apply('initiated');
      await ledger.apply('failed');
      await ledger.apply('reverse-failed');
      expect(await codeOf(ledger.planOnly('reverse-failed'))).toBe(ErrorCode.PAYOUT_NOT_REVERSED);
    });

    it('accepts reverse-failed after a reversal, not just after a failure', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');
      await ledger.apply('reversed');
      await expect(ledger.planOnly('reverse-failed')).resolves.toBeDefined();
    });

    it('accepts reversing again after a reverse-failed, since the payout stands as paid out', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');
      await ledger.apply('reversed');
      await ledger.apply('reverse-failed');
      await expect(ledger.planOnly('reversed')).resolves.toBeDefined();
    });

    it('keeps payouts independent: another payoutId has its own state', async () => {
      await ledger.apply('initiated');
      const other = { ...PARAMS, payoutId: 'po-2' };
      await expect(ledger.planOnly('initiated', other)).resolves.toBeDefined();
      expect(await codeOf(ledger.planOnly('success', other))).toBe(ErrorCode.PAYOUT_NOT_INITIATED);
    });
  });
});
