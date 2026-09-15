import { CONFIG, loadConfig } from '../../../src/config';
import { ConfigModule } from '../../../src/config/config.module';

describe('loadConfig', () => {
  it('falls back to local defaults for an empty environment', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv)).toEqual({
      mongoUri: 'mongodb://localhost:27017',
      dbName: 'ledger',
      defaultTenantId: '',
      apiKeys: [],
      occMaxRetries: 3,
      httpPort: 3003,
      serverEnv: 'development',
    });
  });

  it('reads every value from the environment', () => {
    expect(
      loadConfig({
        MONGO_PATH: 'mongodb://mongo:27017',
        DB_NAME: 'wallets',
        DEFAULT_TENANT_ID: 'acme',
        API_KEYS: 'a,b,c',
        OCC_MAX_RETRIES: '9',
        HTTP_PORT: '8080',
        SERVER_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      mongoUri: 'mongodb://mongo:27017',
      dbName: 'wallets',
      defaultTenantId: 'acme',
      apiKeys: ['a', 'b', 'c'],
      occMaxRetries: 9,
      httpPort: 8080,
      serverEnv: 'production',
    });
  });

  it('splits a single API key into a one-element list', () => {
    expect(loadConfig({ API_KEYS: 'only-key' } as NodeJS.ProcessEnv).apiKeys).toEqual(['only-key']);
  });

  it('treats an empty API_KEYS as no keys at all', () => {
    expect(loadConfig({ API_KEYS: '' } as NodeJS.ProcessEnv).apiKeys).toEqual([]);
  });

  it('keeps an explicitly empty default tenant rather than substituting', () => {
    expect(loadConfig({ DEFAULT_TENANT_ID: '' } as NodeJS.ProcessEnv).defaultTenantId).toBe('');
  });

  it.each([
    ['unparseable', 'abc'],
    ['zero', '0'],
  ])('falls back to 3 OCC retries when the value is %s', (_label, value) => {
    expect(loadConfig({ OCC_MAX_RETRIES: value } as NodeJS.ProcessEnv).occMaxRetries).toBe(3);
  });

  it('reads process.env when called with no argument', () => {
    const original = process.env.DB_NAME;
    process.env.DB_NAME = 'from-process-env';
    try {
      expect(loadConfig().dbName).toBe('from-process-env');
    } finally {
      if (original === undefined) delete process.env.DB_NAME;
      else process.env.DB_NAME = original;
    }
  });

  it('yields NaN for a non-numeric port rather than silently defaulting', () => {
    expect(Number.isNaN(loadConfig({ HTTP_PORT: 'abc' } as NodeJS.ProcessEnv).httpPort)).toBe(true);
  });
});

describe('ConfigModule', () => {
  it('provides the loaded config under the CONFIG token', () => {
    const providers = Reflect.getMetadata('providers', ConfigModule);
    expect(providers).toHaveLength(1);
    expect(providers[0].provide).toBe(CONFIG);
    expect(providers[0].useFactory()).toEqual(loadConfig());
  });

  it('exports CONFIG and is global', () => {
    expect(Reflect.getMetadata('exports', ConfigModule)).toEqual([CONFIG]);
    expect(Reflect.getMetadata('__module:global__', ConfigModule)).toBe(true);
  });
});
