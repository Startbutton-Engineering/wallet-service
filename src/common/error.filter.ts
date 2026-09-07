import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Response } from 'express';
import { ErrorResponse, ErrorCode, AppError } from './errors'

@Catch()
export class AppExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse() as Response;

    if (exception instanceof AppError) {
      res.status(exception.httpStatus).json(exception.toErrorResponse());
      return
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: ErrorResponse = {
        code: status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
        message: exception.message,
        retryable: false
      }
      res.status(status).json(body);
      return;
    }
    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    const body: ErrorResponse = {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal error',
      retryable: false
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}