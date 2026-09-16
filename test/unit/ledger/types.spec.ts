import { OutboxEventType, signedDelta } from '../../../src/ledger/types';

describe('signedDelta', () => {
  it('treats a credit as an increase and a debit as a decrease', () => {
    expect(signedDelta('credit', 100n)).toBe(100n);
    expect(signedDelta('debit', 100n)).toBe(-100n);
  });

  it('is zero-preserving', () => {
    expect(signedDelta('credit', 0n)).toBe(0n);
    expect(signedDelta('debit', 0n)).toBe(-0n);
  });

  it('cancels a matching debit and credit, so a balanced entry nets to zero', () => {
    expect(signedDelta('credit', 250n) + signedDelta('debit', 250n)).toBe(0n);
  });

  it('keeps precision beyond 2^53', () => {
    expect(signedDelta('debit', 9007199254740993n)).toBe(-9007199254740993n);
  });
});

describe('OutboxEventType', () => {
  it('names every published event', () => {
    expect(Object.values(OutboxEventType)).toEqual([
      'CollectionReceived',
      'CollectionSettled',
      'PayoutInitiated',
      'PayoutSucceeded',
      'PayoutFailed',
      'PayoutReversed',
      'PayoutReverseFailed',
      'WalletTransferred',
    ]);
  });
});
