import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { LedgerService } from "./ledger.service";
import { IdempotencyRepository } from "./idempotency.repository";
import { OutboxRepository } from "./outbox.repository";
import { EntriesRepository } from "./entries.repository";
import { PostingsRepository } from "./postings.repository";
import { Posting, PostingSchema } from "./schemas/posting.schema";
import { Entry, EntrySchema } from "./schemas/entry.schema";
import { Idempotency, IdempotencySchema } from "./schemas/idempotency.schema";
import { Outbox, OutboxSchema } from "./schemas/outbox.schema";
import { Account, AccountSchema } from "../accounts/account.schema";
import { LegacyWalletsService } from "./legacy-wallets.service";
import { LegacyRouteService } from "./legacy-route.service";

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
  providers: [ LedgerService, IdempotencyRepository, OutboxRepository, EntriesRepository, PostingsRepository, LegacyWalletsService, LegacyRouteService ],
  exports: [ LedgerService, IdempotencyRepository, OutboxRepository, EntriesRepository, PostingsRepository, LegacyWalletsService, LegacyRouteService, MongooseModule ]
})
export class LedgerModule {}
