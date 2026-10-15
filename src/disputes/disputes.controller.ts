import { Body, Controller, Post } from "@nestjs/common";
import { DisputesService } from "./disputes.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { disputeAcceptSchema } from "./dto";
import type { DisputeAcceptDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post('accept')
  @ResponseMessage('Dispute accepted')
  async accept(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(disputeAcceptSchema)) body: DisputeAcceptDto
  ) {
    return await this.disputes.accept({
      tenantId,
      idempotencyKey,
      disputeId: body.disputeId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      allowOverdraft: body.allowOverdraft,
    })
  }
}
