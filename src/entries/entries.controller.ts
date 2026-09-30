import { Controller, Get, Param, Query } from "@nestjs/common";
import { ResponseMessage } from "../common/api-response";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { EntriesService } from "./entries.service";
import { entryLookupSchema } from "./dto";
import type { EntryLookupDto } from "./dto";

@Controller('entries')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  @ResponseMessage('Entries retrieved')
  async lookup(
    @TenantId() tenantId: string,
    @Query(new ZodValidationPipe(entryLookupSchema)) query: EntryLookupDto,
  ) {
    return await this.entries.lookup(tenantId, query);
  }

  @Get(':entryId')
  @ResponseMessage('Entry retrieved')
  async get(@TenantId() tenantId: string, @Param('entryId') entryId: string) {
    return await this.entries.get(tenantId, entryId);
  }
}
