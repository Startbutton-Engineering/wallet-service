import { Decimal128 } from "mongodb";
import { fromDecimal128, money, toBigInt, toDecimal128 } from "../../../src/common/money"

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