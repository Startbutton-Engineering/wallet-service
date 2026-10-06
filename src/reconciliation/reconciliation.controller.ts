import { Controller, Param, Post, Query } from "@nestjs/common";
import { ResponseMessage } from "../common/api-response";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { forTenant, ReconciliationService } from "./reconciliation.service";
import { ownerReconciliationQuerySchema } from "./dto";
import type { OwnerReconciliationQueryDto } from "./dto";

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('runs')
  @ResponseMessage('Reconciliation run completed')
  async trigger(@TenantId() tenantId: string) {
    return forTenant(await this.reconciliation.trigger('manual'), tenantId);
  }

  @Post('owners/:ownerId')
  @ResponseMessage('Owner reconciliation completed')
  async triggerForOwner(
    @TenantId() tenantId: string,
    @Param('ownerId') ownerId: string,
    @Query(new ZodValidationPipe(ownerReconciliationQuerySchema)) query: OwnerReconciliationQueryDto,
  ) {
    return forTenant(await this.reconciliation.triggerForOwner(tenantId, ownerId, query.currency), tenantId);
  }
}
