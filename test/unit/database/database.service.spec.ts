import { Connection } from 'mongoose';
import { DatabaseService } from '../../../src/database/database.service';
import { DatabaseModule } from '../../../src/database/database.module';
import { CONFIG, loadConfig } from '../../../src/config';
import { mockSession } from '../../mocks';

interface FakeDb {
  command: jest.Mock;
  collection: jest.Mock;
}

function makeConnection(db: FakeDb | undefined, session = mockSession()) {
  return {
    db,
    startSession: jest.fn(async () => session),
  } as unknown as Connection;
}

const fakeDb = (): FakeDb => ({
  command: jest.fn(async () => ({ ok: 1 })),
  collection: jest.fn((name: string) => ({ name })),
});

describe('DatabaseService', () => {
  it('exposes the underlying driver db once mongoose has connected', () => {
    const db = fakeDb();
    expect(new DatabaseService(makeConnection(db)).db).toBe(db);
  });

  it('throws a clear error when the connection has no db yet', () => {
    expect(() => new DatabaseService(makeConnection(undefined)).db).toThrow(
      'Mongoose connection is not established yet',
    );
  });

  it('exposes the mongoose connection itself', () => {
    const connection = makeConnection(fakeDb());
    expect(new DatabaseService(connection).conn).toBe(connection);
  });

  it('resolves a named collection through the driver db', () => {
    const db = fakeDb();
    const service = new DatabaseService(makeConnection(db));

    expect(service.collection('accounts')).toEqual({ name: 'accounts' });
    expect(db.collection).toHaveBeenCalledWith('accounts');
  });

  it('delegates startSession to the connection', async () => {
    const session = mockSession();
    const connection = makeConnection(fakeDb(), session);

    await expect(new DatabaseService(connection).startSession()).resolves.toBe(session);
  });

  it('pings true when the server answers ok', async () => {
    const db = fakeDb();
    await expect(new DatabaseService(makeConnection(db)).ping()).resolves.toBe(true);
    expect(db.command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('pings false when the server answers anything else', async () => {
    const db = fakeDb();
    db.command.mockResolvedValue({ ok: 0 });
    await expect(new DatabaseService(makeConnection(db)).ping()).resolves.toBe(false);
  });

  it('propagates a failed ping command', async () => {
    const db = fakeDb();
    db.command.mockRejectedValue(new Error('unreachable'));
    await expect(new DatabaseService(makeConnection(db)).ping()).rejects.toThrow('unreachable');
  });
});

describe('DatabaseModule', () => {
  it('is global and exports the service, config and mongoose', () => {
    expect(Reflect.getMetadata('__module:global__', DatabaseModule)).toBe(true);
    expect(Reflect.getMetadata('providers', DatabaseModule)).toEqual([DatabaseService]);
    expect(Reflect.getMetadata('exports', DatabaseModule)).toContain(DatabaseService);
  });

  it('builds the mongoose connection options from the injected config', () => {
    const imports = Reflect.getMetadata('imports', DatabaseModule);
    const mongooseRoot = imports.find((m: any) => m?.module?.name === 'MongooseModule');
    const core = mongooseRoot.imports.find((m: any) => m?.module?.name === 'MongooseCoreModule');
    const factoryProvider = core.providers.find((p: any) => p.inject?.includes(CONFIG));

    expect(factoryProvider).toBeDefined();

    const config = { ...loadConfig({} as NodeJS.ProcessEnv), mongoUri: 'mongodb://x', dbName: 'wallets' };
    expect(factoryProvider.useFactory(config)).toEqual({ uri: 'mongodb://x', dbName: 'wallets' });
  });
});
