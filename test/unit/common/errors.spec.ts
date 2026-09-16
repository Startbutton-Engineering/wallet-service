import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorCode, OccConflict } from '../../../src/common/errors';

describe('AppError', () => {
  it('is an Error named AppError that keeps its message', () => {
    const err = AppError.validation('bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.message).toBe('bad input');
  });

  it('omits `details` from the response body when there are none', () => {
    expect(AppError.validation('bad input').toErrorResponse()).toEqual({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'bad input',
      retryable: false,
    });
  });

  it('carries `details` through to the response body when present', () => {
    expect(AppError.validation('bad input', { field: 'amount' }).toErrorResponse()).toEqual({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'bad input',
      retryable: false,
      details: { field: 'amount' },
    });
  });

  it('defaults to non-retryable', () => {
    expect(new AppError(ErrorCode.INTERNAL_ERROR, 500, 'boom').retryable).toBe(false);
  });

  it('marks only retry-exhaustion as retryable', () => {
    const err = AppError.retryExhausted();
    expect(err.code).toBe(ErrorCode.CONCURRENCY_RETRY_EXHAUSTED);
    expect(err.httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.retryable).toBe(true);
  });

  it('uses a default message for unauthenticated and allows overriding it', () => {
    expect(AppError.unauthenticated().message).toBe('Missing or invalid API key');
    expect(AppError.unauthenticated('nope').message).toBe('nope');
    expect(AppError.unauthenticated().httpStatus).toBe(HttpStatus.UNAUTHORIZED);
  });

  describe('factories map to the right code and status', () => {
    const cases: [string, AppError, ErrorCode, number][] = [
      ['validation', AppError.validation('m'), ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST],
      ['unauthenticated', AppError.unauthenticated(), ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED],
      [
        'missingIdempotencyKey',
        AppError.missingIdempotencyKey(),
        ErrorCode.MISSING_IDEMPOTENCY_KEY,
        HttpStatus.BAD_REQUEST,
      ],
      [
        'insufficientFunds',
        AppError.insufficientFunds({ available: '0' }),
        ErrorCode.INSUFFICIENT_FUNDS,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'IdempotencyKeyReuse',
        AppError.IdempotencyKeyReuse('k1'),
        ErrorCode.IDEMPOTENCY_KEY_REUSE,
        HttpStatus.CONFLICT,
      ],
      ['invalidCurrency', AppError.invalidCurrency('XXX'), ErrorCode.INVALID_CURRENCY, HttpStatus.BAD_REQUEST],
      ['notFound', AppError.notFound('gone'), ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND],
      [
        'collectionAlreadyReceived',
        AppError.collectionAlreadyReceived('c1'),
        ErrorCode.COLLECTION_ALREADY_RECEIVED,
        HttpStatus.CONFLICT,
      ],
      [
        'collectionOverSettlement',
        AppError.collectionOverSettlement({ requested: '1' }),
        ErrorCode.COLLECTION_OVER_SETTLEMENT,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'payoutAlreadyInitiated',
        AppError.payoutAlreadyInitiated('p1'),
        ErrorCode.PAYOUT_ALREADY_INITIATED,
        HttpStatus.CONFLICT,
      ],
      [
        'payoutNotInitiated',
        AppError.payoutNotInitiated('p1'),
        ErrorCode.PAYOUT_NOT_INITIATED,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'payoutAlreadyResolved',
        AppError.payoutAlreadyResolved({ payoutId: 'p1' }),
        ErrorCode.PAYOUT_ALREADY_RESOLVED,
        HttpStatus.CONFLICT,
      ],
      [
        'payoutNotSuccessful',
        AppError.payoutNotSuccessful({ payoutId: 'p1' }),
        ErrorCode.PAYOUT_NOT_SUCCESSFUL,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'payoutNotReversed',
        AppError.payoutNotReversed({ payoutId: 'p1' }),
        ErrorCode.PAYOUT_NOT_REVERSED,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'payoutAmountMismatch',
        AppError.payoutAmountMismatch({ payoutId: 'p1' }),
        ErrorCode.PAYOUT_AMOUNT_MISMATCH,
        HttpStatus.UNPROCESSABLE_ENTITY,
      ],
      [
        'walletTransferAlreadyApplied',
        AppError.walletTransferAlreadyApplied('tr1'),
        ErrorCode.WALLET_TRANSFER_ALREADY_APPLIED,
        HttpStatus.CONFLICT,
      ],
    ];

    it.each(cases)('%s', (_name, err, code, status) => {
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
      expect(err.message.length).toBeGreaterThan(0);
    });
  });

  it('puts the offending identifier into details', () => {
    expect(AppError.IdempotencyKeyReuse('k1').details).toEqual({ idempotencyKey: 'k1' });
    expect(AppError.collectionAlreadyReceived('c1').details).toEqual({ collectionId: 'c1' });
    expect(AppError.payoutAlreadyInitiated('p1').details).toEqual({ payoutId: 'p1' });
    expect(AppError.payoutNotInitiated('p1').details).toEqual({ payoutId: 'p1' });
    expect(AppError.walletTransferAlreadyApplied('tr1').details).toEqual({ transferId: 'tr1' });
    expect(AppError.invalidCurrency('XXX').message).toBe('Unknown currency: XXX');
    expect(AppError.notFound('gone', { id: 1 }).details).toEqual({ id: 1 });
  });
});

describe('OccConflict', () => {
  it('is a plain Error so LedgerService can retry on it', () => {
    expect(new OccConflict()).toBeInstanceOf(Error);
  });
});
