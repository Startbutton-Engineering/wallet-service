import { creditWithDebtPaydown, debitWithOverdraft, reverseOverdraftDebit } from '../../../src/collections/credit-policy';
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

describe('debitWithOverdraft', () => {
  const debit = (amount: bigint, available: bigint, allowOverdraft = true) =>
    debitWithOverdraft({ ownerId: OWNER, currency: CURRENCY, amount, available, allowOverdraft });
  const legs = (result: ReturnType<typeof debit>) =>
    result.postings.map((p) => [(p.account as any).accountType, p.direction, p.amount]);

  it('takes the whole amount from available when it covers it', () => {
    const result = debit(150n, 500n);
    expect(result).toMatchObject({ fromAvailable: 150n, deficit: 0n });
    expect(legs(result)).toEqual([['available', 'debit', 150n]]);
  });

  it('drains available and books the rest as debt', () => {
    const result = debit(150n, 100n);
    expect(result).toMatchObject({ fromAvailable: 100n, deficit: 50n });
    expect(legs(result)).toEqual([
      ['available', 'debit', 100n],
      ['refund-chargeback', 'debit', 50n],
    ]);
  });

  it('books everything as debt when available is empty or negative', () => {
    expect(legs(debit(150n, 0n))).toEqual([['refund-chargeback', 'debit', 150n]]);
    expect(legs(debit(150n, -10n))).toEqual([['refund-chargeback', 'debit', 150n]]);
  });

  it('without an overdraft debits available in full and books no debt', () => {
    const result = debit(150n, 100n, false);
    expect(result).toMatchObject({ fromAvailable: 150n, deficit: 0n });
    expect(legs(result)).toEqual([['available', 'debit', 150n]]);
  });

  it('emits no postings for a zero amount', () => {
    expect(debit(0n, 100n)).toEqual({ postings: [], fromAvailable: 0n, deficit: 0n });
  });

  it('always splits the amount exactly', () => {
    for (const [amount, available] of [[150n, 500n], [150n, 100n], [150n, 0n], [1n, 1n]] as [bigint, bigint][]) {
      const result = debit(amount, available);
      expect(result.fromAvailable + result.deficit).toBe(amount);
      expect(result.postings.reduce((sum, p) => sum + p.amount, 0n)).toBe(amount);
    }
  });
});

describe('reverseOverdraftDebit', () => {
  const reverse = (amount: bigint, deficit: bigint, refundChargeBackBalance: bigint) =>
    reverseOverdraftDebit({ ownerId: OWNER, currency: CURRENCY, amount, deficit, refundChargeBackBalance });
  const legs = (result: ReturnType<typeof reverse>) =>
    result.postings.map((p) => [(p.account as any).accountType, p.direction, p.amount]);

  it('cancels the debt the debit created and restores the rest to available', () => {
    const result = reverse(150n, 50n, -50n);
    expect(result).toMatchObject({ toDebt: 50n, toAvailable: 100n });
    expect(legs(result)).toEqual([
      ['refund-chargeback', 'credit', 50n],
      ['available', 'credit', 100n],
    ]);
  });

  it('caps the debt credit at what is still outstanding', () => {
    expect(reverse(150n, 50n, -20n)).toMatchObject({ toDebt: 20n, toAvailable: 130n });
    expect(legs(reverse(150n, 50n, 0n))).toEqual([['available', 'credit', 150n]]);
  });

  it('never touches debt the debit did not create', () => {
    expect(reverse(150n, 0n, -80n)).toMatchObject({ toDebt: 0n, toAvailable: 150n });
  });

  it('puts everything against the debt when the debit was entirely debt', () => {
    expect(legs(reverse(150n, 150n, -150n))).toEqual([['refund-chargeback', 'credit', 150n]]);
  });

  it('never credits more debt than the amount being reversed', () => {
    expect(reverse(100n, 150n, -500n)).toMatchObject({ toDebt: 100n, toAvailable: 0n });
  });
});
