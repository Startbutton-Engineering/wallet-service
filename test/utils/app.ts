import { INestApplication } from "@nestjs/common";
import { Test } from '@nestjs/testing'
import { DatabaseService } from "../../src/database/database.service";
import { CONFIG, loadConfig } from "../../src/config";
import { randomUUID } from "crypto";
import { AppModule } from "../../src/app.module";
import { AppExceptionsFilter } from "../../src/common/error.filter";
import { mongo } from "mongoose";
import { MESSAGE_QUEUE } from "../../src/queue/message-queue";
import { InMemoryQueue } from "./in-memory-queue";

export const TEST_API_KEY = 'test-key';

export interface TestApp {
  app: INestApplication;
  db: DatabaseService;
  /** back-end's database stand-in, holding the legacy `wallets` collection. */
  legacyDb: mongo.Db;
  /** Stands in for RabbitMQ: queued work runs only when the test drains it. */
  queue: InMemoryQueue;
  close: () => Promise<void>
}

export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

export interface TestAppOptions {
  /** Share one database between several apps, e.g. to run two schedulers against it. */
  dbName?: string;
}

export async function createTestApp(overrides: ProviderOverride[] = [], options: TestAppOptions = {}): Promise<TestApp> {
  const uri = process.env.TEST_MONGO_PATH
  if(!uri) throw new Error('TEST_MONGO_PATH not set - global test setup did not run')

  const config = loadConfig({
    MONGO_PATH: uri,
    DB_NAME: options.dbName ?? `ledger_test_${randomUUID().replace(/-/g, '')}`,
    // back-end's database stand-in: a cut-over owner's `wallets` documents are updated from the ledger.
    LEGACY_DB_NAME: `legacy_test_${randomUUID().replace(/-/g, '')}`,
    API_KEYS: TEST_API_KEY,
  } as NodeJS.ProcessEnv)

  const queue = new InMemoryQueue()
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(MESSAGE_QUEUE)
    .useValue(queue)
  for (const o of overrides) {
    builder = builder.overrideProvider(o.provide as never).useValue(o.useValue)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppExceptionsFilter());
  await app.init()

  const mongo = app.get(DatabaseService);

  const legacyDb = mongo.conn.getClient().db(config.legacyDbName);

  return {
    app,
    db: mongo,
    legacyDb,
    queue,
    close: async() => {
      await mongo.db.dropDatabase().catch(() => undefined);
      await legacyDb.dropDatabase().catch(() => undefined);
      await app.close();
    }
  }
}