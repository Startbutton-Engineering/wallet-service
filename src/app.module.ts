import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard';
import { ResponseInterceptor } from './common/response.interceptor';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { CurrencyModule } from './currency/currency.module';
import { AccountsModule } from './accounts/accounts.module';
import { WalletsModule } from './wallets/wallets.module';
import { LedgerModule } from './ledger/ledger.module';
import { CollectionsModule } from './collections/collections.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ConversionsModule } from './conversions/conversions.module';
import { SettlementsModule } from './settlements/settlements.module';
import { EntriesModule } from './entries/entries.module';
import { RefundsModule } from './refunds/refunds.module';
import { TopupsModule } from './topups/topups.module';
import { LiensModule } from './liens/liens.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReportsModule } from './reports/reports.module';

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
    EntriesModule,
    RefundsModule,
    TopupsModule,
    LiensModule,
    ReconciliationModule,
    ReportsModule
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard},
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
