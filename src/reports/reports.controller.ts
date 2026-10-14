import { Controller, Get, Param, Query } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AppError } from "../common/errors";
import { RunsRepository } from "../reconciliation/runs.repository";
import { runView } from "../reconciliation/reconciliation.service";
import { runHistoryQuerySchema } from "../reconciliation/dto";
import type { RunHistoryQueryDto } from "../reconciliation/dto";
import { ResponseMessage } from "../common/api-response";
import { TenantId } from "../common/tenant.decorator";
import { ReportsService } from "./reports.service";

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly runs: RunsRepository,
  ) {}

  @Get('trial-balance')
  @ResponseMessage('Trial balance retrieved')
  async trialBalance(@TenantId() tenantId: string) {
    return await this.reports.trialBalance(tenantId);
  }

  @Get('system-positions')
  @ResponseMessage('System positions retrieved')
  async systemPositions(@TenantId() tenantId: string) {
    return await this.reports.systemPositions(tenantId);
  }

  @Get('reconciliation')
  @ResponseMessage('Reconciliation history retrieved')
  async reconciliationHistory(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(runHistoryQuerySchema)) query: RunHistoryQueryDto,
  ) {
    const latest = await this.runs.latestFullRun();
    const { runs, nextCursor } = await this.runs.list(tenantId, query);
    return {
      latest: latest ? runView(latest, tenantId) : null,
      runs: runs.map((r) => runView(r, tenantId)),
      nextCursor,
    };
  }

  @Get('reconciliation/:runId')
  @ResponseMessage('Reconciliation run retrieved')
  async reconciliationRun(@TenantId() tenantId: string, @Param('runId') runId: string) {
    const run = await this.runs.get(tenantId, runId);
    if (!run) throw AppError.notFound('Reconciliation run not found', { runId });
    return { run: runView(run, tenantId), findings: await this.runs.findingsFor(run._id, tenantId) };
  }
}
