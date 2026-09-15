import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard';
import { CurrencyModule } from './currency/currency.module';
import { AccountsModule } from './accounts/accounts.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [DatabaseModule, CurrencyModule, AccountsModule, WalletsModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard}
  ],
})
export class AppModule {}
