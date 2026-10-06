import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppModule } from '../../../src/app.module';
import { ApiKeyGuard } from '../../../src/auth/api-key.guard';
import { ResponseInterceptor } from '../../../src/common/response.interceptor';
import { HealthController } from '../../../src/health/health.controller';
import { DatabaseModule } from '../../../src/database/database.module';
import { CurrencyModule } from '../../../src/currency/currency.module';
import { AccountsModule } from '../../../src/accounts/accounts.module';
import { LedgerModule } from '../../../src/ledger/ledger.module';
import { WalletsModule } from '../../../src/wallets/wallets.module';
import { CollectionsModule } from '../../../src/collections/collections.module';
import { PayoutsModule } from '../../../src/payouts/payouts.module';
import { ConversionsModule } from '../../../src/conversions/conversions.module';
import { SettlementsModule } from '../../../src/settlements/settlements.module';
import { AccountsRepository } from '../../../src/accounts/accounts.repository';
import { LedgerService } from '../../../src/ledger/ledger.service';
import { IdempotencyRepository } from '../../../src/ledger/idempotency.repository';
import { OutboxRepository } from '../../../src/ledger/outbox.repository';
import { EntriesRepository } from '../../../src/ledger/entries.repository';
import { PostingsRepository } from '../../../src/ledger/postings.repository';
import { EntriesModule } from '../../../src/entries/entries.module';
import { RefundsModule } from '../../../src/refunds/refunds.module';
import { ReconciliationModule } from '../../../src/reconciliation/reconciliation.module';
import { ReportsModule } from '../../../src/reports/reports.module';
import { RefundsService } from '../../../src/refunds/refunds.service';
import { RefundsController } from '../../../src/refunds/refunds.controller';
import { EntriesService } from '../../../src/entries/entries.service';
import { EntriesController } from '../../../src/entries/entries.controller';
import { StatementService } from '../../../src/wallets/statement.service';
import { CurrencyRegistryService } from '../../../src/currency/currency-registry.service';
import { CurrencyController } from '../../../src/currency/currency.controller';
import { WalletsService } from '../../../src/wallets/wallets.service';
import { WalletsController } from '../../../src/wallets/wallets.controller';
import { CollectionsService } from '../../../src/collections/collection.service';
import { CollectionsController } from '../../../src/collections/collections.controller';
import { PayoutsService } from '../../../src/payouts/payouts.service';
import { PayoutsController } from '../../../src/payouts/payouts.controller';
import { ConversionsService } from '../../../src/conversions/conversions.service';
import { ConversionsController } from '../../../src/conversions/conversions.controller';
import { SettlementsService } from '../../../src/settlements/settlements.service';
import { SettlementsController } from '../../../src/settlements/settlements.controller';

const meta = (module: unknown, key: string) => Reflect.getMetadata(key, module as never);

describe('AppModule', () => {
  it('wires every feature module', () => {
    expect(meta(AppModule, 'imports')).toEqual([
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
      ReconciliationModule,
      ReportsModule,
    ]);
  });

  it('serves the health endpoint itself', () => {
    expect(meta(AppModule, 'controllers')).toEqual([HealthController]);
  });

  it('applies the API-key guard and the response envelope to every route', () => {
    expect(meta(AppModule, 'providers')).toEqual([
      { provide: APP_GUARD, useClass: ApiKeyGuard },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    ]);
  });
});

describe('feature modules', () => {
  it.each([
    ['AccountsModule', AccountsModule, [AccountsRepository], []],
    [
      'LedgerModule',
      LedgerModule,
      [LedgerService, IdempotencyRepository, OutboxRepository, EntriesRepository, PostingsRepository],
      [],
    ],
    ['CurrencyModule', CurrencyModule, [CurrencyRegistryService], [CurrencyController]],
    ['WalletsModule', WalletsModule, [WalletsService, StatementService], [WalletsController]],
    ['CollectionsModule', CollectionsModule, [CollectionsService], [CollectionsController]],
    ['PayoutsModule', PayoutsModule, [PayoutsService], [PayoutsController]],
    ['RefundsModule', RefundsModule, [RefundsService], [RefundsController]],
    ['ConversionsModule', ConversionsModule, [ConversionsService], [ConversionsController]],
    ['SettlementsModule', SettlementsModule, [SettlementsService], [SettlementsController]],
    ['EntriesModule', EntriesModule, [EntriesService], [EntriesController]],
  ] as [string, unknown, unknown[], unknown[]][])(
    '%s declares its providers and controllers',
    (_name, module, providers, controllers) => {
      expect(meta(module, 'providers')).toEqual(providers);
      expect(meta(module, 'controllers') ?? []).toEqual(controllers);
    },
  );

  it.each([
    ['AccountsModule', AccountsModule, AccountsRepository],
    ['LedgerModule', LedgerModule, LedgerService],
    ['CurrencyModule', CurrencyModule, CurrencyRegistryService],
    ['WalletsModule', WalletsModule, WalletsService],
    ['CollectionsModule', CollectionsModule, CollectionsService],
    ['PayoutsModule', PayoutsModule, PayoutsService],
    ['ConversionsModule', ConversionsModule, ConversionsService],
    ['SettlementsModule', SettlementsModule, SettlementsService],
  ] as [string, unknown, unknown][])('%s exports its main provider', (_name, module, provider) => {
    expect(meta(module, 'exports')).toContain(provider);
  });

  it.each([
    ['AccountsModule', AccountsModule],
    ['LedgerModule', LedgerModule],
    ['CurrencyModule', CurrencyModule],
  ] as [string, unknown][])('%s is global, so its providers need no re-import', (_name, module) => {
    expect(meta(module, '__module:global__')).toBe(true);
  });

  it.each([
    ['WalletsModule', WalletsModule],
    ['CollectionsModule', CollectionsModule],
    ['PayoutsModule', PayoutsModule],
    ['ConversionsModule', ConversionsModule],
    ['SettlementsModule', SettlementsModule],
  ] as [string, unknown][])('%s is scoped rather than global', (_name, module) => {
    expect(meta(module, '__module:global__')).toBeUndefined();
  });

  it('registers the five mongo models the ledger writes to', () => {
    const [feature] = meta(LedgerModule, 'imports');
    const names = feature.providers
      .map((p: any) => p.provide)
      .filter((name: unknown) => typeof name === 'string');

    expect(names).toEqual(
      expect.arrayContaining(['PostingModel', 'EntryModel', 'IdempotencyModel', 'OutboxModel', 'AccountModel']),
    );
  });
});
