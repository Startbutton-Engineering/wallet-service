import { Body, Controller, Post } from "@nestjs/common";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ResponseMessage } from "../common/api-response";
import { CutoverService } from "./cutover.service";
import { cutoverSchema } from "./dto";
import type { CutoverDto } from "./dto";

@Controller('migrations')
export class MigrationsController {
  constructor(private readonly cutovers: CutoverService) {}

  /** What a cutover would seed. Reads only. */
  @Post('cutover/preview')
  @ResponseMessage('Cutover preview')
  async preview(@Body(new ZodValidationPipe(cutoverSchema)) body: CutoverDto) {
    return await this.cutovers.preview(body.ownerId);
  }

  @Post('cutover')
  @ResponseMessage('Owner cut over to the ledger')
  async cutover(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(cutoverSchema)) body: CutoverDto,
  ) {
    return await this.cutovers.cutover(tenantId, idempotencyKey, body.ownerId);
  }
}
