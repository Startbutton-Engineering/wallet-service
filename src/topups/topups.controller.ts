import { Body, Controller, Post } from "@nestjs/common";
import { TopupsService } from "./topups.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { topupSchema } from "./dto";
import type { TopupDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('topups')
export class TopupsController {
  constructor(private readonly topups: TopupsService) {}

  @Post('credit')
  @ResponseMessage('Topup credited')
  async credit(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(topupSchema)) body: TopupDto
  ) {
    return await this.topups.credit({
      tenantId,
      idempotencyKey,
      topupId: body.topupId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
    })
  }
}
