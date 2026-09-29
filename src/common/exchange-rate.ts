/** Parses a plain (non-exponential) non-negative decimal string into an integer and the
 * number of digits after the point, e.g. "1500.50" -> { integer: 150050n, scale: 2 }. */
export function parseScaledDecimal(value: string): { integer: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Not a plain positive decimal string: ${value}`);
  }
  const [whole, frac = ''] = value.split('.');
  return { integer: BigInt(whole + frac), scale: frac.length };
}

export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Converts an amount in one currency's minor units to another's, given a decimal
 * exchange rate quoted as "whole `from`-currency units per 1 whole `to`-currency unit"
 * (e.g. NGN per USD: rate "1500.50" means 1 USD = 1500.50 NGN).
 *
 * Rounds to the nearest `to`-currency minor unit, half rounding up. 
 **/
export function convertMinorUnits(
  amount: bigint,
  fromScale: number,
  toScale: number,
  rate: string,
): bigint {
  if (amount < 0n) throw new Error(`Amount to convert must not be negative, got ${amount}`);
  const { integer: rateInt, scale: rateScale } = parseScaledDecimal(rate);
  if (rateInt <= 0n) throw new Error(`Exchange rate must be positive, got ${rate}`);

  const numerator = amount * 10n ** BigInt(rateScale + toScale);
  const denominator = rateInt * 10n ** BigInt(fromScale);
  return divideRoundHalfUp(numerator, denominator);
}
