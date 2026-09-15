import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { LedgerService } from "./ledger.service";
import { IdempotencyRepository } from "./idempotency.repository";
import { OutboxRepository } from "./outbox.repository";
import { Posting, PostingSchema } from "./schemas/posting.schema";
import { Entry, EntrySchema } from "./schemas/entry.schema";
import { Idempotency, IdempotencySchema } from "./schemas/idempotency.schema";
import { Outbox, OutboxSchema } from "./schemas/outbox.schema";
import { Account, AccountSchema } from "../accounts/account.schema";

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Posting.name, schema: PostingSchema },
      { name: Entry.name, schema: EntrySchema },
      { name: Idempotency.name, schema: IdempotencySchema },
      { name: Outbox.name, schema: OutboxSchema },
      { name: Account.name, schema: AccountSchema }
    ])
  ],
  providers: [ LedgerService, IdempotencyRepository, OutboxRepository ],
  exports: [ LedgerService, IdempotencyRepository, OutboxRepository, MongooseModule ]
})
export class LedgerModule {}
