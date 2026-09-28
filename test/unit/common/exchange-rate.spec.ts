import {
  convertMinorUnits,
  divideRoundHalfUp,
  parseScaledDecimal,
} from '../../../src/common/exchange-rate';

describe('parseScaledDecimal', () => {
  it('parses a whole number as scale 0', () => {
    expect(parseScaledDecimal('1500')).toEqual({ integer: 1500n, scale: 0 });
  });

  it('parses a decimal, counting digits after the point', () => {
    expect(parseScaledDecimal('1500.50')).toEqual({ integer: 150050n, scale: 2 });
  });

  it.each(['-5', '1e3', 'abc', '1.2.3', ''])('rejects %s as not a plain decimal', (value) => {
    expect(() => parseScaledDecimal(value)).toThrow('Not a plain positive decimal string');
  });
});

describe('divideRoundHalfUp', () => {
  it('rounds down below the halfway point', () => {
    expect(divideRoundHalfUp(100n, 300n)).toBe(0n); // 0.333...
  });

  it('rounds up exactly at the halfway point', () => {
    expect(divideRoundHalfUp(1n, 2n)).toBe(1n); // 0.5
  });

  it('rounds up above the halfway point', () => {
    expect(divideRoundHalfUp(2n, 3n)).toBe(1n); // 0.666...
  });

  it('is exact when the division has no remainder', () => {
    expect(divideRoundHalfUp(150000n, 150000n)).toBe(1n);
  });
});

describe('convertMinorUnits', () => {
  it('converts exactly when the division has no remainder', () => {
    // ₦1500.00 at ₦1500/$1 -> $1.00
    expect(convertMinorUnits(150_000n, 2, 2, '1500')).toBe(100n);
  });

  it('rounds a repeating decimal half-up', () => {
    // ₦1000.00 at ₦1500.50/$1 -> $0.666... -> $0.67
    expect(convertMinorUnits(100_000n, 2, 2, '1500.50')).toBe(67n);
  });

  it('handles a rate with more decimal places than either currency scale', () => {
    expect(convertMinorUnits(1_000_000n, 2, 2, '1500.1234')).toBe(667n);
  });

  it('rounds exactly on the half-up boundary', () => {
    // ₦1.01 at ₦2/$1 -> $0.505 -> $0.51
    expect(convertMinorUnits(101n, 2, 2, '2')).toBe(51n);
  });

  it('rounds down to zero when the converted amount is under half a minor unit', () => {
    expect(convertMinorUnits(1n, 2, 2, '300')).toBe(0n);
  });

  it('returns zero for a zero amount without throwing', () => {
    expect(convertMinorUnits(0n, 2, 2, '1500')).toBe(0n);
  });

  it('loses no precision for large amounts', () => {
    const large = 9_007_199_254_740_991n; // Number.MAX_SAFE_INTEGER
    expect(convertMinorUnits(large, 2, 2, '1')).toBe(large);
  });

  it('generalizes across differing minor-unit scales', () => {
    // ₦1500.00 (scale 2) at ₦1500/$1 -> $1.00 in a scale-10 currency
    expect(convertMinorUnits(150_000n, 2, 10, '1500')).toBe(10_000_000_000n);
  });

  it.each(['0', '-5', '1e3', 'abc'])('rejects an invalid rate %s', (rate) => {
    expect(() => convertMinorUnits(100n, 2, 2, rate)).toThrow();
  });

  it('rejects a negative amount', () => {
    expect(() => convertMinorUnits(-1n, 2, 2, '100')).toThrow('must not be negative');
  });
});
