import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard';
import { ResponseInterceptor } from './common/response.interceptor';
import { CurrencyModule } from './currency/currency.module';
import { AccountsModule } from './accounts/accounts.module';
import { WalletsModule } from './wallets/wallets.module';
import { LedgerModule } from './ledger/ledger.module';
import { CollectionsModule } from './collections/collections.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ConversionsModule } from './conversions/conversions.module';
import { SettlementsModule } from './settlements/settlements.module';
import { EntriesModule } from './entries/entries.module';

@Module({
  imports: [
    DatabaseModule,
    CurrencyModule,
    AccountsModule,
    LedgerModule,
    WalletsModule,
    CollectionsModule,
    PayoutsModule,
    ConversionsModule,
    SettlementsModule,
    EntriesModule
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard},
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }
  ],
})
export class AppModule {}
