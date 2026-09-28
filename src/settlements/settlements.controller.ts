import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ResponseMessage } from "../common/api-response";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SettlementsService } from "./settlements.service";
import {
  initiateSettlementSchema,
  listPendingSettlementsSchema,
  resolveSettlementSchema,
} from "./dto";
import type { InitiateSettlementDto, ListPendingSettlementsDto, ResolveSettlementDto } from "./dto";

@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post('initiate')
  @ResponseMessage('Settlement initiated')
  async initiate(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(initiateSettlementSchema)) body: InitiateSettlementDto,
  ) {
    return await this.settlements.initiate({
      tenantId,
      idempotencyKey,
      settlementId: body.settlementId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      walletType: body.walletType,
    });
  }

  @Post('success')
  @ResponseMessage('Settlement succeeded')
  async success(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(resolveSettlementSchema)) body: ResolveSettlementDto,
  ) {
    return await this.settlements.resolve({ tenantId, idempotencyKey, ...body, status: 'success' });
  }

  @Post('fail')
  @ResponseMessage('Settlement failed')
  async fail(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(resolveSettlementSchema)) body: ResolveSettlementDto,
  ) {
    return await this.settlements.resolve({ tenantId, idempotencyKey, ...body, status: 'failed' });
  }

  @Get('pending')
  @ResponseMessage('Pending settlements retrieved')
  async pending(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(listPendingSettlementsSchema)) query: ListPendingSettlementsDto,
  ) {
    return await this.settlements.listPending(tenantId, query.limit);
  }
}
