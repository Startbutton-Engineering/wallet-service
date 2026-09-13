import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import { AppError } from "./errors";

export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const key = req.header('idempotency-key');
  if (!key || !key.trim()) throw AppError.missingIdempotencyKey();
  return key.trim();
});