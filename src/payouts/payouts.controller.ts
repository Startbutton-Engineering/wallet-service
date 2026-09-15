import { Body, Controller, Post } from "@nestjs/common";
import { PayoutsService } from "./payouts.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { payoutStatusSchema } from "./dto";
import type { PayoutStatusDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post('status')
  @ResponseMessage('Payout status applied')
  async status(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(payoutStatusSchema)) body: PayoutStatusDto
  ) {
    return await this.payouts.status({
      tenantId,
      idempotencyKey,
      payoutId: body.payoutId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      status: body.status,
    })
  }
}
