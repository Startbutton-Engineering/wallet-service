import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Response } from 'express';
import { ErrorResponse, ErrorCode, AppError } from './errors'
import { ApiErrorData, ApiResponse } from "./api-response";

@Catch()
export class AppExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse() as Response;

    if (exception instanceof AppError) {
      this.send(res, exception.httpStatus, exception.toErrorResponse());
      return
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: ErrorResponse = {
        code: status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        message: exception.message,
        retryable: false
      }
      this.send(res, status, body);
      return;
    }
    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    const body: ErrorResponse = {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal error',
      retryable: false
    };
    this.send(res, HttpStatus.INTERNAL_SERVER_ERROR, body);
  }

  /** Errors use the same envelope as successes: the human-readable text stays in
   * `message`, the machine-readable code/retryable/details move into `data`. */
  private send(res: Response, status: number, error: ErrorResponse): void {
    const body: ApiResponse<ApiErrorData> = {
      success: false,
      message: error.message,
      data: {
        code: error.code,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    };
    res.status(status).json(body);
  }
}
