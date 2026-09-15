import { amountString } from '../../../src/common/amount-schema.validator';

describe('amountString', () => {
  it.each(['1', '100', '9007199254740993'])('accepts the minor-unit string %s', (value) => {
    expect(amountString.parse(value)).toBe(value);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['empty', ''],
    ['whitespace padded', ' 1 '],
    ['decimal', '1.5'],
    ['non-numeric', 'abc'],
    ['exponential', '1e3'],
  ])('rejects %s with a validation issue', (_label, value) => {
    expect(amountString.safeParse(value).success).toBe(false);
  });

  /** A malformed amount must fail validation, never throw: the regex check aborts the
   * pipeline so the `BigInt(s)` in the refine below it is only ever reached for digits.
   * Without that, a non-numeric amount escaped the pipe as a 500 instead of a 400. */
  it.each(['abc', '1.5', '1e3', '-1', ''])('does not throw on the malformed amount %p', (value) => {
    expect(() => amountString.safeParse(value)).not.toThrow();
  });

  it('reports one issue per malformed amount, naming the format it wants', () => {
    const result = amountString.safeParse('abc');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toMatch(/integer string/);
  });

  it('rejects a number rather than coercing it', () => {
    expect(amountString.safeParse(100).success).toBe(false);
  });

  it('explains that a zero amount is not positive', () => {
    const result = amountString.safeParse('0');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('amount must be positive');
  });
});
