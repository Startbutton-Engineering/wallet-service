import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard';
import { CurrencyModule } from './currency/currency.module';

@Module({
  imports: [DatabaseModule, CurrencyModule],
  controllers: [HealthController,],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard}
  ],
})
export class AppModule {}
