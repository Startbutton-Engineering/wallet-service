import { Global, Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { IdempotencyRepository } from "./idempotency.repository";
import { OutboxRepository } from "./outbox.repository";

@Global()
@Module({
  providers: [ LedgerService, IdempotencyRepository, OutboxRepository ],
  exports: [ LedgerService, IdempotencyRepository, OutboxRepository ]
})
export class LedgerModule {}