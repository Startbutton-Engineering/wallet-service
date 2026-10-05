import { accountRef, refKey } from '../../../src/accounts/account';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { signedDelta } from '../../../src/ledger/types';
import { REFUND_TRANSITIONS, RefundOperation } from '../../../src/refunds/refund-transitions';
import {
  REFUND_FEE_TRANSITIONS,
  RefundFeeOperation,
  RefundFeeStatus,
  RefundFeeTransitionParams,
} from '../../../src/refunds/refund-fee-transitions';
import { BalanceLedger } from '../../mocks';

const FEE: RefundFeeTransitionParams = {
  refundId: 'rf-1',
  transferReference: 'trf_rf-1',
  ownerId: 'm1',
  currency: 'NGN',
  amount: 50n,
};

const available = accountRef.collectionWallet('m1', 'NGN', 'available');
const held = accountRef.collectionWallet('m1', 'NGN', 'held-outflow');
const refunds = accountRef.systemRefunds('NGN');

class FeeLedger extends BalanceLedger {
  /** Put the refund itself through `pending`, as back-end always does before charging the fee. */
  async refundPending(amount = 1000n) {
    const plan = await REFUND_TRANSITIONS.pending.plan(this.ctx, {
      refundId: FEE.refundId, ownerId: 'm1', currency: 'NGN', amount, allowOverdraft: false,
    });
    this.record(FEE.refundId, RefundOperation.pending, plan.entries);
  }

  async apply(status: RefundFeeStatus, params: RefundFeeTransitionParams = FEE) {
    const transition = REFUND_FEE_TRANSITIONS[status];
    const plan = await transition.plan(this.ctx, params);
    return { plan, entryId: this.record(params.transferReference, transition.operationType, plan.entries) };
  }

  planOnly(status: RefundFeeStatus, params: RefundFeeTransitionParams = FEE) {
    return REFUND_FEE_TRANSITIONS[status].plan(this.ctx, params);
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

describe('refund fee transitions', () => {
  let ledger: FeeLedger;

  beforeEach(async () => {
    ledger = new FeeLedger();
    ledger.seed(available, 2000n);
    await ledger.refundPending();
  });

  describe('postings', () => {
    it('initiated holds the fee: available -> held-outflow, guarding available', async () => {
      const plan = await ledger.planOnly('initiated');

      expect(legs(plan)).toEqual([
        [refKey(available), 'debit', 50n],
        [refKey(held), 'credit', 50n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([refKey(available)]);
    });

    it('stamps every entry with the refund the fee is for', async () => {
      const plan = await ledger.planOnly('initiated');
      expect(plan.entries[0].metadata).toEqual({
        refundId: 'rf-1',
        transferReference: 'trf_rf-1',
        purpose: 'refund-transfer-fee',
      });
    });

    it('success charges the held fee to external:refunds', async () => {
      await ledger.apply('initiated');
      const { plan } = await ledger.apply('success');

      expect(legs(plan)).toEqual([
        [refKey(held), 'debit', 50n],
        [refKey(refunds), 'credit', 50n],
      ]);
      expect(plan.entries[0].metadata).toMatchObject({ refundId: 'rf-1' });
      expect(ledger.balanceOf(held)).toBe(0n);
      expect(ledger.balanceOf(available)).toBe(950n);
    });

    it('reversed releases the hold back to available and cites the initiation', async () => {
      const initiate = await ledger.apply('initiated');
      const { plan } = await ledger.apply('reversed');

      expect(legs(plan)).toEqual([
        [refKey(held), 'debit', 50n],
        [refKey(available), 'credit', 50n],
      ]);
      expect(plan.reversalOf).toBe(initiate.entryId);
      expect(ledger.balanceOf(available)).toBe(1000n);
    });

    it('reverse-failed charges the returned fee straight from available, guarding it', async () => {
      await ledger.apply('initiated');
      await ledger.apply('reversed');
      const { plan } = await ledger.apply('reverse-failed');

      expect(legs(plan)).toEqual([
        [refKey(available), 'debit', 50n],
        [refKey(refunds), 'credit', 50n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([refKey(available)]);
      expect(ledger.balanceOf(available)).toBe(950n);
    });

    it('files the fee under the transfer reference, leaving the refund in flight untouched', async () => {
      await ledger.apply('initiated');
      await ledger.apply('success');

      expect(await ledger.ctx.referenceNetAmount('rf-1', refunds)).toBe(1000n);
      expect(await ledger.ctx.referenceNetAmount('trf_rf-1', refunds)).toBe(50n);
    });
  });

  describe('preconditions', () => {
    it('rejects charging a fee for a refund that never went pending', async () => {
      expect(await codeOf(ledger.planOnly('initiated', { ...FEE, refundId: 'rf-unknown' }))).toBe(
        ErrorCode.REFUND_NOT_INITIATED,
      );
    });

    it('rejects initiating the same fee twice', async () => {
      await ledger.apply('initiated');
      expect(await codeOf(ledger.planOnly('initiated'))).toBe(ErrorCode.REFUND_FEE_ALREADY_INITIATED);
    });

    it.each(['success', 'reversed'] as RefundFeeStatus[])('rejects %s before the fee is initiated', async (status) => {
      expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.REFUND_FEE_NOT_INITIATED);
    });

    it.each([
      ['success', 'success'],
      ['success', 'reversed'],
      ['reversed', 'success'],
      ['reversed', 'reversed'],
    ] as [RefundFeeStatus, RefundFeeStatus][])('rejects %s once the fee already went %s', async (next, first) => {
      await ledger.apply('initiated');
      await ledger.apply(first);
      expect(await codeOf(ledger.planOnly(next))).toBe(ErrorCode.REFUND_FEE_ALREADY_RESOLVED);
    });

    it.each(['success', 'reversed'] as RefundFeeStatus[])('rejects %s for a different amount', async (status) => {
      await ledger.apply('initiated');
      expect(await codeOf(ledger.planOnly(status, { ...FEE, amount: 49n }))).toBe(
        ErrorCode.REFUND_FEE_AMOUNT_MISMATCH,
      );
    });

    it('rejects reverse-failed unless the fee was reversed', async () => {
      await ledger.apply('initiated');
      expect(await codeOf(ledger.planOnly('reverse-failed'))).toBe(ErrorCode.REFUND_FEE_NOT_REVERSED);
    });

    it('rejects reverse-failed twice', async () => {
      await ledger.apply('initiated');
      await ledger.apply('reversed');
      await ledger.apply('reverse-failed');
      expect(await codeOf(ledger.planOnly('reverse-failed'))).toBe(ErrorCode.REFUND_FEE_NOT_REVERSED);
    });

    it('rejects reverse-failed for a different amount', async () => {
      await ledger.apply('initiated');
      await ledger.apply('reversed');
      expect(await codeOf(ledger.planOnly('reverse-failed', { ...FEE, amount: 1n }))).toBe(
        ErrorCode.REFUND_FEE_AMOUNT_MISMATCH,
      );
    });
  });

  it('keeps every entry balanced and positive along initiated -> reversed -> reverse-failed', async () => {
    const plans = [
      (await ledger.apply('initiated')).plan,
      (await ledger.apply('reversed')).plan,
      (await ledger.apply('reverse-failed')).plan,
    ];
    for (const plan of plans) {
      for (const entry of plan.entries) {
        expect(entry.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n)).toBe(0n);
        expect(entry.postings.every((p) => p.amount > 0n)).toBe(true);
      }
    }
  });

  it('stamps stable operation types', () => {
    expect(RefundFeeOperation).toEqual({
      initiate: 'refund.fee.initiate',
      success: 'refund.fee.success',
      reverse: 'refund.fee.reverse',
      reverseFailed: 'refund.fee.reverse-failed',
    });
  });
});
