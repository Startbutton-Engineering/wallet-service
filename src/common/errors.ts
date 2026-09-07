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
  // System
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
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
    return new AppError(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message)
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

  static notFound(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND, message, false, details)
  }
}