import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { AppExceptionsFilter } from '../../../src/common/error.filter';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { mockExecutionContext, mockResponse } from '../../mocks';

describe('AppExceptionsFilter', () => {
  let filter: AppExceptionsFilter;
  let response: ReturnType<typeof mockResponse>;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    filter = new AppExceptionsFilter();
    response = mockResponse();
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const host = () => mockExecutionContext({ response }).asHost;

  it('renders an AppError with its own status, code and details', () => {
    filter.catch(AppError.insufficientFunds({ available: '10' }), host());

    expect(response.statusCode).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.body).toEqual({
      success: false,
      message: 'Insufficient funds to complete the transaction.',
      data: {
        code: ErrorCode.INSUFFICIENT_FUNDS,
        retryable: false,
        details: { available: '10' },
      },
    });
  });

  it('leaves `details` out of the envelope when the AppError has none', () => {
    filter.catch(AppError.unauthenticated(), host());

    expect(response.statusCode).toBe(HttpStatus.UNAUTHORIZED);
    expect(response.body).toEqual({
      success: false,
      message: 'Missing or invalid API key',
      data: { code: ErrorCode.UNAUTHENTICATED, retryable: false },
    });
  });

  it('keeps the retryable flag for a retryable AppError', () => {
    filter.catch(AppError.retryExhausted(), host());
    expect(response.body).toMatchObject({ data: { retryable: true } });
  });

  it('maps a 404 HttpException to NOT_FOUND', () => {
    filter.catch(new NotFoundException('no such route'), host());

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      success: false,
      message: 'no such route',
      data: { code: ErrorCode.NOT_FOUND, retryable: false },
    });
  });

  it('maps any other HttpException to VALIDATION_FAILED at its own status', () => {
    filter.catch(new HttpException('teapot', 418), host());

    expect(response.statusCode).toBe(418);
    expect(response.body).toMatchObject({ data: { code: ErrorCode.VALIDATION_FAILED } });
  });

  it('turns an unknown Error into a logged 500 that leaks nothing', () => {
    filter.catch(new Error('mongo exploded'), host());

    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.body).toEqual({
      success: false,
      message: 'Internal error',
      data: { code: ErrorCode.INTERNAL_ERROR, retryable: false },
    });
    expect(logError).toHaveBeenCalledWith('Unhandled exception', expect.stringContaining('mongo exploded'));
  });

  it('stringifies a non-Error throw for the log', () => {
    filter.catch('just a string', host());

    expect(logError).toHaveBeenCalledWith('Unhandled exception', 'just a string');
    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
