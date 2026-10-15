import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { loadConfig } from "../config";
import type { ErrorResponse } from "./errors";

/** res.locals key the exception filter fills so the completion line can say why a request failed. */
export const ERROR_LOCAL = 'error';

/** Logs one line when a request arrives and one when its response is sent, for every route.
 * Runs before guards and pipes, so auth and validation failures are logged too. Headers are
 * never logged — they carry the API key. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const { method } = req;
    const url = req.originalUrl;
    // Same fallback as @TenantId(), so this matches the tenant the request actually ran as
    const tenant = req.header('x-tenant-id')?.trim() || loadConfig().defaultTenantId || '-';
    const idempotencyKey = req.header('idempotency-key')?.trim() || '-';
    const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;

    this.logger.log(
      `--> ${method} ${url} tenant=${tenant} idempotencyKey=${idempotencyKey}` +
        (hasBody ? ` body=${JSON.stringify(req.body)}` : ''),
    );

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const error = res.locals[ERROR_LOCAL] as ErrorResponse | undefined;
      const line =
        `<-- ${method} ${url} ${res.statusCode} ${ms.toFixed(1)}ms tenant=${tenant} idempotencyKey=${idempotencyKey}` +
        (error
          ? ` error=${error.code} message="${error.message}"` +
            (error.details ? ` details=${JSON.stringify(error.details)}` : '')
          : '');

      if (res.statusCode >= 500) this.logger.error(line);
      else if (res.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }
}
