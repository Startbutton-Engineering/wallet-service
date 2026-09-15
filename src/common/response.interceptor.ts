import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { ApiResponse, DEFAULT_SUCCESS_MESSAGE, RESPONSE_MESSAGE_KEY } from "./api-response";

/** Wraps every successful handler return value in the standard ApiResponse envelope.
 * Failures never reach here — they are wrapped by AppExceptionsFilter instead. */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T | null>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T | null>> {
    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_SUCCESS_MESSAGE;

    return next.handle().pipe(
      map((data) => ({
        success: true,
        message,
        data: data ?? null,
      }))
    );
  }
}
