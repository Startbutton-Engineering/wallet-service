import { HttpStatus } from "@nestjs/common";

export enum ErrorCode {
  // Validation / request
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_CURRENCY = 'INVALID_CURRENCY',
  MISSING_IDEMPOTENCY_KEY = 'MISSING_IDEMPOTENCY_KEY',
  // Auth
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  // Business
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  IDEMPOTENCY_KEY_REUSE = 'IDEMPOTENCY_KEY_REUSE',
  NOT_FOUND = 'NOT_FOUND',
  COLLECTION_ALREADY_RECEIVED = 'COLLECTION_ALREADY_RECEIVED',
  COLLECTION_OVER_SETTLEMENT = 'COLLECTION_OVER_SETTLEMENT',
  PAYOUT_ALREADY_INITIATED = 'PAYOUT_ALREADY_INITIATED',
  PAYOUT_NOT_INITIATED = 'PAYOUT_NOT_INITIATED',
  PAYOUT_ALREADY_RESOLVED = 'PAYOUT_ALREADY_RESOLVED',
  PAYOUT_NOT_SUCCESSFUL = 'PAYOUT_NOT_SUCCESSFUL',
  PAYOUT_NOT_REVERSED = 'PAYOUT_NOT_REVERSED',
  PAYOUT_AMOUNT_MISMATCH = 'PAYOUT_AMOUNT_MISMATCH',
  WALLET_TRANSFER_ALREADY_APPLIED = 'WALLET_TRANSFER_ALREADY_APPLIED',
  CONVERSION_ALREADY_INITIATED = 'CONVERSION_ALREADY_INITIATED',
  CONVERSION_NOT_INITIATED = 'CONVERSION_NOT_INITIATED',
  CONVERSION_ALREADY_RESOLVED = 'CONVERSION_ALREADY_RESOLVED',
  SETTLEMENT_ALREADY_INITIATED = 'SETTLEMENT_ALREADY_INITIATED',
  SETTLEMENT_NOT_INITIATED = 'SETTLEMENT_NOT_INITIATED',
  SETTLEMENT_ALREADY_RESOLVED = 'SETTLEMENT_ALREADY_RESOLVED',
  REFUND_ALREADY_INITIATED = 'REFUND_ALREADY_INITIATED',
  REFUND_NOT_INITIATED = 'REFUND_NOT_INITIATED',
  REFUND_ALREADY_RESOLVED = 'REFUND_ALREADY_RESOLVED',
  REFUND_AMOUNT_MISMATCH = 'REFUND_AMOUNT_MISMATCH',
  REFUND_FEE_ALREADY_INITIATED = 'REFUND_FEE_ALREADY_INITIATED',
  REFUND_FEE_NOT_INITIATED = 'REFUND_FEE_NOT_INITIATED',
  REFUND_FEE_ALREADY_RESOLVED = 'REFUND_FEE_ALREADY_RESOLVED',
  REFUND_FEE_NOT_REVERSED = 'REFUND_FEE_NOT_REVERSED',
  REFUND_FEE_AMOUNT_MISMATCH = 'REFUND_FEE_AMOUNT_MISMATCH',
  // System
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  CONCURRENCY_RETRY_EXHAUSTED = 'CONCURRENCY_RETRY_EXHAUSTED'
}

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AppError'
  }

  toErrorResponse(): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message, false, details)
  }

  static unauthenticated(message = 'Missing or invalid API key'): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, message)
  }

  static missingIdempotencyKey(): AppError {
    return new AppError(
      ErrorCode.MISSING_IDEMPOTENCY_KEY,
      HttpStatus.BAD_REQUEST,
      'An Idempotency key header is required for mutating requests. Please provide a unique Idempotency key in the request header.'
    )
  }

  static insufficientFunds(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.INSUFFICIENT_FUNDS,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Insufficient funds to complete the transaction.',
      false,
      details
    )
  }

  static IdempotencyKeyReuse(key: string): AppError {
    return new AppError(
      ErrorCode.IDEMPOTENCY_KEY_REUSE,
      HttpStatus.CONFLICT,
      'The provided Idempotency key has already been used for a previous request.',
      false,
      { idempotencyKey: key}
    )
  }

  static invalidCurrency(currency: string): AppError {
    return new AppError(ErrorCode.INVALID_CURRENCY, HttpStatus.BAD_REQUEST, `Unknown currency: ${currency}`, false)
  }

  static notFound(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND, message, false, details)
  }

  static collectionAlreadyReceived(collectionId: string): AppError {
    return new AppError(
      ErrorCode.COLLECTION_ALREADY_RECEIVED,
      HttpStatus.CONFLICT,
      `Collection ${collectionId} has already been received.`,
      false,
      { collectionId }
    )
  }

  static collectionOverSettlement(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.COLLECTION_OVER_SETTLEMENT,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Settlement amount exceeds the outstanding amount for this collection.',
      false,
      details
    )
  }

  static payoutAlreadyInitiated(payoutId: string): AppError {
    return new AppError(
      ErrorCode.PAYOUT_ALREADY_INITIATED,
      HttpStatus.CONFLICT,
      `Payout ${payoutId} has already been initiated.`,
      false,
      { payoutId }
    )
  }

  static payoutNotInitiated(payoutId: string): AppError {
    return new AppError(
      ErrorCode.PAYOUT_NOT_INITIATED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Payout ${payoutId} was never initiated.`,
      false,
      { payoutId }
    )
  }

  static payoutAlreadyResolved(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.PAYOUT_ALREADY_RESOLVED,
      HttpStatus.CONFLICT,
      'This payout has already succeeded or failed; its funds are no longer held.',
      false,
      details
    )
  }

  static payoutNotSuccessful(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.PAYOUT_NOT_SUCCESSFUL,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Only a payout that has been paid out can be reversed.',
      false,
      details
    )
  }

  static payoutNotReversed(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.PAYOUT_NOT_REVERSED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'This payout has no returned funds to re-debit; it must have failed or been reversed first.',
      false,
      details
    )
  }

  static payoutAmountMismatch(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.PAYOUT_AMOUNT_MISMATCH,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Payout amount does not match the outstanding amount for this payout.',
      false,
      details
    )
  }

  static walletTransferAlreadyApplied(transferId: string): AppError {
    return new AppError(
      ErrorCode.WALLET_TRANSFER_ALREADY_APPLIED,
      HttpStatus.CONFLICT,
      `Wallet transfer ${transferId} has already been applied.`,
      false,
      { transferId }
    )
  }

  static conversionAlreadyInitiated(conversionId: string): AppError {
    return new AppError(
      ErrorCode.CONVERSION_ALREADY_INITIATED,
      HttpStatus.CONFLICT,
      `Conversion ${conversionId} has already been initiated.`,
      false,
      { conversionId }
    )
  }

  static conversionNotInitiated(conversionId: string): AppError {
    return new AppError(
      ErrorCode.CONVERSION_NOT_INITIATED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Conversion ${conversionId} was never initiated.`,
      false,
      { conversionId }
    )
  }

  static conversionAlreadyResolved(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.CONVERSION_ALREADY_RESOLVED,
      HttpStatus.CONFLICT,
      'This conversion has already been approved or rejected; its funds are no longer held.',
      false,
      details
    )
  }

  static settlementAlreadyInitiated(settlementId: string): AppError {
    return new AppError(
      ErrorCode.SETTLEMENT_ALREADY_INITIATED,
      HttpStatus.CONFLICT,
      `Settlement ${settlementId} has already been initiated.`,
      false,
      { settlementId }
    )
  }

  static settlementNotInitiated(settlementId: string): AppError {
    return new AppError(
      ErrorCode.SETTLEMENT_NOT_INITIATED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Settlement ${settlementId} was never initiated.`,
      false,
      { settlementId }
    )
  }

  static settlementAlreadyResolved(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.SETTLEMENT_ALREADY_RESOLVED,
      HttpStatus.CONFLICT,
      'This settlement has already succeeded or failed; its funds are no longer held.',
      false,
      details
    )
  }

  static refundAlreadyInitiated(refundId: string): AppError {
    return new AppError(
      ErrorCode.REFUND_ALREADY_INITIATED,
      HttpStatus.CONFLICT,
      `Refund ${refundId} has already been initiated.`,
      false,
      { refundId }
    )
  }

  static refundNotInitiated(refundId: string): AppError {
    return new AppError(
      ErrorCode.REFUND_NOT_INITIATED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Refund ${refundId} was never initiated.`,
      false,
      { refundId }
    )
  }

  static refundAlreadyResolved(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_ALREADY_RESOLVED,
      HttpStatus.CONFLICT,
      'This refund has already succeeded or failed.',
      false,
      details
    )
  }

  static refundAmountMismatch(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_AMOUNT_MISMATCH,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Refund amount does not match the outstanding amount for this refund.',
      false,
      details
    )
  }

  static refundFeeAlreadyInitiated(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_FEE_ALREADY_INITIATED,
      HttpStatus.CONFLICT,
      'The transfer fee for this refund has already been initiated.',
      false,
      details
    )
  }

  static refundFeeNotInitiated(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_FEE_NOT_INITIATED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The transfer fee for this refund was never initiated.',
      false,
      details
    )
  }

  static refundFeeAlreadyResolved(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_FEE_ALREADY_RESOLVED,
      HttpStatus.CONFLICT,
      'The transfer fee for this refund has already succeeded or been reversed; it is no longer held.',
      false,
      details
    )
  }

  static refundFeeNotReversed(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_FEE_NOT_REVERSED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'This transfer fee has no returned funds to re-debit; it must have been reversed first.',
      false,
      details
    )
  }

  static refundFeeAmountMismatch(details: Record<string, unknown>): AppError {
    return new AppError(
      ErrorCode.REFUND_FEE_AMOUNT_MISMATCH,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Fee amount does not match the outstanding transfer fee for this refund.',
      false,
      details
    )
  }

  static retryExhausted(): AppError {
    return new AppError(
      ErrorCode.CONCURRENCY_RETRY_EXHAUSTED,
      HttpStatus.SERVICE_UNAVAILABLE,
      'Concurrent modification retry limit exceeded; retry the request',
      true
    )
  }
}

export class OccConflict extends Error {}