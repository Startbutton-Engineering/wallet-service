import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import { loadConfig } from "../config";

export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const header = req.header('x-tenant-id');
  return header && header.trim() ? header.trim() : loadConfig().defaultTenantId;
})