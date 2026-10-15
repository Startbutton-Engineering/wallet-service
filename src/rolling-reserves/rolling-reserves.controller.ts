import { Body, Controller, Post } from "@nestjs/common";
import { RollingReservesService } from "./rolling-reserves.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { rollingReserveReleaseSchema } from "./dto";
import type { RollingReserveReleaseDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('rolling-reserves')
export class RollingReservesController {
  constructor(private readonly rollingReserves: RollingReservesService) {}

  @Post('release')
  @ResponseMessage('Rolling reserve released')
  async release(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(rollingReserveReleaseSchema)) body: RollingReserveReleaseDto
  ) {
    return await this.rollingReserves.release({
      tenantId,
      idempotencyKey,
      releaseId: body.releaseId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
    })
  }
}
