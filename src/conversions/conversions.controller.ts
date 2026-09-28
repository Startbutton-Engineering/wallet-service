import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ResponseMessage } from "../common/api-response";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConversionsService } from "./conversions.service";
import {
  initiateConversionSchema,
  listPendingConversionsSchema,
  resolveConversionSchema,
} from "./dto";
import type { InitiateConversionDto, ListPendingConversionsDto, ResolveConversionDto } from "./dto";

@Controller('conversions')
export class ConversionsController {
  constructor(private readonly conversions: ConversionsService) {}

  @Post('initiate')
  @ResponseMessage('Conversion initiated')
  async initiate(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(initiateConversionSchema)) body: InitiateConversionDto,
  ) {
    return await this.conversions.initiate({
      tenantId,
      idempotencyKey,
      conversionId: body.conversionId,
      ownerId: body.ownerId,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      fromAmount: BigInt(body.fromAmount),
      rate: body.rate,
      walletType: body.walletType,
    });
  }

  @Post('approve')
  @ResponseMessage('Conversion approved')
  async approve(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(resolveConversionSchema)) body: ResolveConversionDto,
  ) {
    return await this.conversions.resolve({
      tenantId,
      idempotencyKey,
      conversionId: body.conversionId,
      ownerId: body.ownerId,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      status: 'approved',
      walletType: body.walletType,
    });
  }

  @Post('reject')
  @ResponseMessage('Conversion rejected')
  async reject(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(resolveConversionSchema)) body: ResolveConversionDto,
  ) {
    return await this.conversions.resolve({
      tenantId,
      idempotencyKey,
      conversionId: body.conversionId,
      ownerId: body.ownerId,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      status: 'rejected',
      walletType: body.walletType,
    });
  }

  @Get('pending')
  @ResponseMessage('Pending conversions retrieved')
  async pending(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(listPendingConversionsSchema)) query: ListPendingConversionsDto,
  ) {
    return await this.conversions.listPending(tenantId, query.limit);
  }
}
