import { Body, Controller, Post } from "@nestjs/common";
import { RefundsService } from "./refunds.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { refundFeeStatusSchema, refundStatusSchema } from "./dto";
import type { RefundFeeStatusDto, RefundStatusDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post('status')
  @ResponseMessage('Refund status applied')
  async status(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(refundStatusSchema)) body: RefundStatusDto
  ) {
    return await this.refunds.status({
      tenantId,
      idempotencyKey,
      refundId: body.refundId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      status: body.status,
      allowOverdraft: body.allowOverdraft,
    })
  }

  @Post('fee/status')
  @ResponseMessage('Refund fee status applied')
  async feeStatus(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(refundFeeStatusSchema)) body: RefundFeeStatusDto
  ) {
    return await this.refunds.feeStatus({
      tenantId,
      idempotencyKey,
      refundId: body.refundId,
      transferReference: body.transferReference,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      status: body.status,
    })
  }
}
