jest.mock('@nestjs/core', () => ({
  ...jest.requireActual('@nestjs/core'),
  NestFactory: { create: jest.fn() },
}));

import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '../../../src/config';

const create = NestFactory.create as unknown as jest.Mock;

const listen = jest.fn(async (_port: number, callback?: () => void) => callback?.());
const app = {
  useGlobalFilters: jest.fn(),
  enableShutdownHooks: jest.fn(),
  listen,
} as unknown as INestApplication;

/** Imports src/main.ts fresh and waits for its top-level bootstrap() to settle.
 * The isolated registry gives main.ts its own copies of AppModule and the filter,
 * so the assertions below identify them by name rather than by reference. */
async function bootstrap(): Promise<void> {
  jest.isolateModules(() => {
    require('../../../src/main');
  });
  await new Promise((resolve) => setImmediate(resolve));
}

describe('bootstrap', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue(app);
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates the Nest application from AppModule without buffering logs', async () => {
    await bootstrap();

    const [module, options] = create.mock.calls[0];
    expect(module.name).toBe('AppModule');
    expect(options).toEqual({ bufferLogs: false });
  });

  it('installs the global exception filter so errors use the standard envelope', async () => {
    await bootstrap();

    const [filter] = (app.useGlobalFilters as jest.Mock).mock.calls[0];
    expect(filter.constructor.name).toBe('AppExceptionsFilter');
    expect(typeof filter.catch).toBe('function');
  });

  it('enables shutdown hooks so mongo connections close cleanly', async () => {
    await bootstrap();
    expect(app.enableShutdownHooks).toHaveBeenCalled();
  });

  it('listens on the configured port and announces it', async () => {
    const port = loadConfig().httpPort || 3000;

    await bootstrap();

    expect(listen).toHaveBeenCalledWith(port, expect.any(Function));
    expect(log).toHaveBeenCalledWith(`Server is running on port ${port}`);
  });

  it('falls back to port 3000 when the configured port is falsy', async () => {
    const original = process.env.HTTP_PORT;
    process.env.HTTP_PORT = '0';
    try {
      await bootstrap();
      expect(listen).toHaveBeenCalledWith(3000, expect.any(Function));
      expect(log).toHaveBeenCalledWith('Server is running on port 3000');
    } finally {
      if (original === undefined) delete process.env.HTTP_PORT;
      else process.env.HTTP_PORT = original;
    }
  });
});
