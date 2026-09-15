import { SetMetadata } from "@nestjs/common";

/** The envelope every endpoint responds with, success or failure.
 * On failure `data` carries the machine-readable error payload (code, retryable,
 * and any details) while `message` stays human-readable. */
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface ApiErrorData {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export const RESPONSE_MESSAGE_KEY = 'api:response-message';

export const DEFAULT_SUCCESS_MESSAGE = 'Request successful';

/** Sets the `message` a route's successful response carries.
 * Without it the route falls back to DEFAULT_SUCCESS_MESSAGE. */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);
