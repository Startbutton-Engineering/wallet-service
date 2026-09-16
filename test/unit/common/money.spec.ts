import { Types } from "mongoose";
import { assertSameCurrency, fromDecimal128, money, toBigInt, toDecimal128 } from "../../../src/common/money"

const { Decimal128 } = Types;

describe('Money', () => {
  it('stores amounts as bigint minor units', () => {
    expect(money(100, 'NGN').amount).toBe(100n);
    expect(money('9007199254740993', 'USDC').amount).toBe(9007199254740993n)
  })

  it('rejects non-integers minor-unit amount', () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });

  it('round-trips through Decimal128 exactly, including beyond 2^53', () => {
    const big = 9007199254740993n;
    const d = toDecimal128(big);
    expect(d).toBeInstanceOf(Decimal128);
    expect(fromDecimal128(d)).toBe(big);
  });

  it('rejects a non-integer Decimal128', () => {
    expect(() => fromDecimal128(Decimal128.fromString('1.5'))).toThrow(/integer/)
  })
})
describe('toBigInt', () => {
  it('passes a bigint straight through', () => {
    expect(toBigInt(42n)).toBe(42n);
  });

  it('accepts a safe integer number and a numeric string', () => {
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt('-42')).toBe(-42n);
  });

  it('accepts zero and negative integers', () => {
    expect(toBigInt(0)).toBe(0n);
    expect(toBigInt(-7)).toBe(-7n);
  });

  it('rejects a non-numeric string', () => {
    expect(() => toBigInt('abc')).toThrow();
  });
});

describe('money', () => {
  it('keeps the currency it was given', () => {
    expect(money(1n, 'USD')).toEqual({ amount: 1n, currency: 'USD' });
  });
});

describe('fromDecimal128', () => {
  it('round-trips zero and negatives', () => {
    expect(fromDecimal128(toDecimal128(0n))).toBe(0n);
    expect(fromDecimal128(toDecimal128(-9007199254740993n))).toBe(-9007199254740993n);
  });

  it('rejects an exponential Decimal128', () => {
    expect(() => fromDecimal128(Decimal128.fromString('1E+3'))).toThrow(/integer/);
  });
});

describe('assertSameCurrency', () => {
  it('passes for two amounts in the same currency', () => {
    expect(() => assertSameCurrency(money(1, 'NGN'), money(2, 'NGN'))).not.toThrow();
  });

  it('throws naming both currencies when they differ', () => {
    expect(() => assertSameCurrency(money(1, 'NGN'), money(2, 'USD'))).toThrow(
      'Currency mismatch: NGN vs USD',
    );
  });
});
