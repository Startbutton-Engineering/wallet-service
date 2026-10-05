import { accountRef, refKey } from '../../../src/accounts/account';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { signedDelta } from '../../../src/ledger/types';
import {
  REFUND_TRANSITIONS,
  RefundOperation,
  RefundStatus,
  RefundTransitionParams,
} from '../../../src/refunds/refund-transitions';
import { BalanceLedger } from '../../mocks';

const PARAMS: RefundTransitionParams = {
  refundId: 'rf-1',
  ownerId: 'm1',
  currency: 'NGN',
  amount: 150n,
  allowOverdraft: true,
};

const available = accountRef.collectionWallet('m1', 'NGN', 'available');
const debt = accountRef.collectionWallet('m1', 'NGN', 'refund-chargeback');
const refunds = accountRef.systemRefunds('NGN');
const collection = accountRef.systemCollection('NGN');

class RefundLedger extends BalanceLedger {
  async apply(status: RefundStatus, params: RefundTransitionParams = PARAMS) {
    const transition = REFUND_TRANSITIONS[status];
    const plan = await transition.plan(this.ctx, params);
    return { plan, entryId: this.record(params.refundId, transition.operationType, plan.entries) };
  }

  planOnly(status: RefundStatus, params: RefundTransitionParams = PARAMS) {
    return REFUND_TRANSITIONS[status].plan(this.ctx, params);
  }
}

const legs = (plan: { entries: { postings: { account: any; direction: string; amount: bigint }[] }[] }) =>
  plan.entries[0].postings.map((p) => [refKey(p.account), p.direction, p.amount]);

async function codeOf(run: Promise<unknown>): Promise<ErrorCode> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
  throw new Error('expected the transition to be rejected');
}

describe('refund transitions', () => {
  let ledger: RefundLedger;

  beforeEach(() => {
    ledger = new RefundLedger();
  });

  describe('pending', () => {
    it('takes the whole refund from available when it covers it, booking no debt', async () => {
      ledger.seed(available, 500n);
      const plan = await ledger.planOnly('pending');

      expect(legs(plan)).toEqual([
        [refKey(available), 'debit', 150n],
        [refKey(refunds), 'credit', 150n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([refKey(available)]);
      expect(plan.eventMetaData).toEqual({ fromAvailable: '150', deficit: '0' });
    });

    it('books the shortfall as refund-chargeback debt when an overdraft is allowed', async () => {
      ledger.seed(available, 100n);
      const plan = await ledger.planOnly('pending');

      expect(legs(plan)).toEqual([
        [refKey(available), 'debit', 100n],
        [refKey(debt), 'debit', 50n],
        [refKey(refunds), 'credit', 150n],
      ]);
      expect(plan.eventMetaData).toEqual({ fromAvailable: '100', deficit: '50' });
    });

    it('books the whole refund as debt when available is empty', async () => {
      const plan = await ledger.planOnly('pending');

      expect(legs(plan)).toEqual([
        [refKey(debt), 'debit', 150n],
        [refKey(refunds), 'credit', 150n],
      ]);
    });

    it('without an overdraft, debits available in full so the guard rejects a shortfall', async () => {
      ledger.seed(available, 100n);
      const plan = await ledger.planOnly('pending', { ...PARAMS, allowOverdraft: false });

      expect(legs(plan)).toEqual([
        [refKey(available), 'debit', 150n],
        [refKey(refunds), 'credit', 150n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([refKey(available)]);
    });

    it('rejects setting the same refund to pending twice', async () => {
      await ledger.apply('pending');
      expect(await codeOf(ledger.planOnly('pending'))).toBe(ErrorCode.REFUND_ALREADY_INITIATED);
    });
  });

  describe('success', () => {
    it('sends the in-flight refund out through the collection rail and leaves the debt in place', async () => {
      ledger.seed(available, 100n);
      await ledger.apply('pending');
      const { plan } = await ledger.apply('success');

      expect(legs(plan)).toEqual([
        [refKey(refunds), 'debit', 150n],
        [refKey(collection), 'credit', 150n],
      ]);
      expect(ledger.balanceOf(refunds)).toBe(0n);
      expect(ledger.balanceOf(debt)).toBe(-50n);
      expect(ledger.balanceOf(available)).toBe(0n);
    });
  });

  describe('failed', () => {
    it('puts available and the debt back exactly as they were before the pending step', async () => {
      ledger.seed(available, 100n);
      const pending = await ledger.apply('pending');
      const { plan } = await ledger.apply('failed');

      expect(legs(plan)).toEqual([
        [refKey(refunds), 'debit', 150n],
        [refKey(debt), 'credit', 50n],
        [refKey(available), 'credit', 100n],
      ]);
      expect(plan.reversalOf).toBe(pending.entryId);
      expect(plan.eventMetaData).toEqual({ restoredToAvailable: '100', restoredToDebt: '50' });
      expect(ledger.balanceOf(available)).toBe(100n);
      expect(ledger.balanceOf(debt)).toBe(0n);
      expect(ledger.balanceOf(refunds)).toBe(0n);
    });

    it('returns debt already repaid in the meantime to available instead of pushing it positive', async () => {
      ledger.seed(available, 100n);
      await ledger.apply('pending');
      // A later collection repaid 30 of the 50 debt before the refund failed.
      ledger.seed(debt, -20n);
      const { plan } = await ledger.apply('failed');

      expect(legs(plan)).toEqual([
        [refKey(refunds), 'debit', 150n],
        [refKey(debt), 'credit', 20n],
        [refKey(available), 'credit', 130n],
      ]);
      expect(ledger.balanceOf(debt)).toBe(0n);
    });

    it('never pays down debt the refund did not create', async () => {
      ledger.seed(available, 500n);
      await ledger.apply('pending');
      ledger.seed(debt, -80n); // debt from some other refund
      const { plan } = await ledger.apply('failed');

      expect(legs(plan)).toEqual([
        [refKey(refunds), 'debit', 150n],
        [refKey(available), 'credit', 150n],
      ]);
      expect(ledger.balanceOf(debt)).toBe(-80n);
    });
  });

  describe('preconditions for success and failed', () => {
    it.each(['success', 'failed'] as RefundStatus[])('rejects %s before the refund is pending', async (status) => {
      expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.REFUND_NOT_INITIATED);
    });

    it.each([
      ['success', 'failed'],
      ['failed', 'success'],
      ['success', 'success'],
      ['failed', 'failed'],
    ] as [RefundStatus, RefundStatus][])('rejects %s once the refund already went %s', async (next, first) => {
      await ledger.apply('pending');
      await ledger.apply(first);
      expect(await codeOf(ledger.planOnly(next))).toBe(ErrorCode.REFUND_ALREADY_RESOLVED);
    });

    it.each(['success', 'failed'] as RefundStatus[])('rejects %s for a different amount', async (status) => {
      await ledger.apply('pending');
      expect(await codeOf(ledger.planOnly(status, { ...PARAMS, amount: 149n }))).toBe(
        ErrorCode.REFUND_AMOUNT_MISMATCH,
      );
    });
  });

  it.each([['success'], ['failed']] as [RefundStatus][])(
    'every entry along pending -> %s is balanced and positive',
    async (status) => {
      ledger.seed(available, 100n);
      const plans = [(await ledger.apply('pending')).plan, (await ledger.apply(status)).plan];
      for (const plan of plans) {
        for (const entry of plan.entries) {
          expect(entry.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n)).toBe(0n);
          expect(entry.postings.every((p) => p.amount > 0n)).toBe(true);
        }
      }
    },
  );

  it('stamps stable operation types', () => {
    expect(RefundOperation).toEqual({
      pending: 'refund.pending',
      success: 'refund.success',
      failed: 'refund.failed',
    });
  });
});
