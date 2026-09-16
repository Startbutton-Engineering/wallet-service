import { HealthController } from '../../../src/health/health.controller';
import { DatabaseService } from '../../../src/database/database.service';
import { IS_PUBLIC_KEY } from '../../../src/auth/public.decorator';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';

function controllerWith(command: jest.Mock): HealthController {
  const database = { db: { command } } as unknown as DatabaseService;
  return new HealthController(database);
}

describe('HealthController', () => {
  it('reports a connected replica set', async () => {
    const command = jest.fn(async (cmd: Record<string, number>) =>
      cmd.ping ? { ok: 1 } : { setName: 'rs0' },
    );

    await expect(controllerWith(command).health()).resolves.toEqual({
      status: 'ok',
      database: { connected: true, replicaSet: true },
    });
    expect(command).toHaveBeenCalledWith({ ping: 1 });
    expect(command).toHaveBeenCalledWith({ isMaster: 1 });
  });

  it('reports a standalone server as connected but not a replica set', async () => {
    const command = jest.fn(async (cmd: Record<string, number>) => (cmd.ping ? { ok: 1 } : {}));

    await expect(controllerWith(command).health()).resolves.toEqual({
      status: 'ok',
      database: { connected: true, replicaSet: false },
    });
  });

  it('stays up and reports the database as down when both commands fail', async () => {
    const command = jest.fn(async () => {
      throw new Error('unreachable');
    });

    await expect(controllerWith(command).health()).resolves.toEqual({
      status: 'ok',
      database: { connected: false, replicaSet: false },
    });
  });

  it('reports a failing isMaster alone as connected without a replica set', async () => {
    const command = jest.fn(async (cmd: Record<string, number>) => {
      if (cmd.ping) return { ok: 1 };
      throw new Error('not authorised');
    });

    await expect(controllerWith(command).health()).resolves.toMatchObject({
      database: { connected: true, replicaSet: false },
    });
  });

  it('is public and carries its response message', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.health)).toBe(true);
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, HealthController.prototype.health)).toBe(
      'Service healthy',
    );
  });
});
