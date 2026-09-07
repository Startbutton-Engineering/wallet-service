import { INestApplication } from "@nestjs/common";
import { Test } from '@nestjs/testing'
import { DatabaseService } from "../../src/database/database.service";
import { CONFIG, loadConfig } from "../../src/config";
import { randomUUID } from "crypto";
import { AppModule } from "../../src/app.module";
import { AppExceptionsFilter } from "../../src/common/error.filter";

export const TEST_API_KEY = 'test-key';

export interface TestApp {
  app: INestApplication;
  db: DatabaseService;
  close: () => Promise<void>
}

export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

export async function createTestApp(overrides: ProviderOverride[] = []): Promise<TestApp> {
  const uri = process.env.TEST_MONGO_PATH
  if(!uri) throw new Error('TEST_MONGO_PATH not set - global test setup did not run')

  const config = loadConfig({
    MONGO_PATH: uri,
    MONGO_DB: `ledger_test_${randomUUID().replace(/-/g, '')}`,
    API_KEYS: TEST_API_KEY,
  } as NodeJS.ProcessEnv)

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
  for (const o of overrides) {
    builder = builder.overrideProvider(o.provide as never).useValue(o.useValue)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppExceptionsFilter());
  await app.init()

  const mongo = app.get(DatabaseService);

  return {
    app,
    db: mongo,
    close: async() => {
      await mongo.db.dropDatabase().catch(() => undefined);
      await app.close();
    }
  }
}