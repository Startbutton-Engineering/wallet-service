import { Body, Controller, Post } from "@nestjs/common";
import { LienAction, LiensService } from "./liens.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { lienSchema } from "./dto";
import type { LienDto } from "./dto";
import { ResponseMessage } from "../common/api-response";

@Controller('liens')
export class LiensController {
  constructor(private readonly liens: LiensService) {}

  @Post('place')
  @ResponseMessage('Lien placed')
  async place(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(lienSchema)) body: LienDto
  ) {
    return await this.apply('place', tenantId, idempotencyKey, body);
  }

  @Post('release')
  @ResponseMessage('Lien released')
  async release(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(lienSchema)) body: LienDto
  ) {
    return await this.apply('release', tenantId, idempotencyKey, body);
  }

  private apply(action: LienAction, tenantId: string, idempotencyKey: string, body: LienDto) {
    return this.liens.apply(action, {
      tenantId,
      idempotencyKey,
      lienId: body.lienId,
      ownerId: body.ownerId,
      walletType: body.walletType,
      currency: body.currency,
      amount: BigInt(body.amount),
    });
  }
}
