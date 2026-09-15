import { Decimal128 } from "mongodb";

export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

export function money(amount: bigint | number | string, currency: string): Money {
  return { amount: toBigInt(amount), currency }
}

export function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string') return BigInt(value)
  if(!Number.isInteger(value)) {
    throw new Error(`Money amount must be an integer number of minor units, got ${value}`)
  }
  return BigInt(value)
}

export function toDecimal128(amount: bigint): Decimal128 {
  return Decimal128.fromString(amount.toString());
}

export function fromDecimal128(value: Decimal128): bigint {
  const str = value.toString();
  if(str.includes('.') || str.includes('E') || str.includes('e')) {
    throw new Error(`Ledger Decimal128 amount is not an integer minor-unit value: ${str}`)
  }
  return BigInt(str)
}

export function assertSameCurrency(a: Money, b:Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`)
  }
}

