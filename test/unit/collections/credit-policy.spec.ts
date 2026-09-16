import { creditWithDebtPaydown } from '../../../src/collections/credit-policy';
import { CURRENCY, OWNER } from '../../mocks';

const paydown = (amount: bigint, refundChargeBackBalance: bigint) =>
  creditWithDebtPaydown({ ownerId: OWNER, currency: CURRENCY, amount, refundChargeBackBalance });

const accountTypes = (result: ReturnType<typeof paydown>) =>
  result.postings.map((p) => [(p.account as any).accountType, p.direction, p.amount]);

describe('creditWithDebtPaydown', () => {
  it('credits the whole amount to available when there is no debt', () => {
    const result = paydown(1000n, 0n);

    expect(result.settled).toBe(0n);
    expect(result.amountToCredit).toBe(1000n);
    expect(accountTypes(result)).toEqual([['available', 'credit', 1000n]]);
  });

  it('ignores a positive refund-chargeback balance, which is not a debt', () => {
    const result = paydown(1000n, 250n);

    expect(result.settled).toBe(0n);
    expect(accountTypes(result)).toEqual([['available', 'credit', 1000n]]);
  });

  it('splits the amount between the debt and available', () => {
    const result = paydown(1000n, -400n);

    expect(result.settled).toBe(400n);
    expect(result.amountToCredit).toBe(600n);
    expect(accountTypes(result)).toEqual([
      ['refund-chargeback', 'credit', 400n],
      ['available', 'credit', 600n],
    ]);
  });

  it('puts everything against the debt when the debt is larger, crediting nothing', () => {
    const result = paydown(300n, -1000n);

    expect(result.settled).toBe(300n);
    expect(result.amountToCredit).toBe(0n);
    expect(accountTypes(result)).toEqual([['refund-chargeback', 'credit', 300n]]);
  });

  it('clears an exactly matching debt with no leftover posting', () => {
    const result = paydown(400n, -400n);

    expect(result).toMatchObject({ settled: 400n, amountToCredit: 0n });
    expect(result.postings).toHaveLength(1);
  });

  it('emits no postings at all for a zero amount', () => {
    expect(paydown(0n, -400n)).toEqual({ postings: [], settled: 0n, amountToCredit: 0n });
  });

  it('always splits the amount exactly, leaving nothing unaccounted for', () => {
    for (const [amount, debt] of [
      [1000n, 0n],
      [1000n, -1n],
      [1n, -1000n],
      [9007199254740993n, -9007199254740992n],
    ] as [bigint, bigint][]) {
      const result = paydown(amount, debt);
      expect(result.settled + result.amountToCredit).toBe(amount);
      expect(result.postings.reduce((sum, p) => sum + p.amount, 0n)).toBe(amount);
    }
  });

  it('points the postings at the owner’s collection wallet', () => {
    const [debtPosting] = paydown(1000n, -400n).postings;
    expect(debtPosting.account).toEqual({
      kind: 'user',
      ownerId: OWNER,
      currency: CURRENCY,
      walletType: 'collection',
      accountType: 'refund-chargeback',
    });
  });
});
