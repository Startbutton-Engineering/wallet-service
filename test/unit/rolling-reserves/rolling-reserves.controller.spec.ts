import { RollingReservesController } from '../../../src/rolling-reserves/rolling-reserves.controller';
import { RollingReservesService } from '../../../src/rolling-reserves/rolling-reserves.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('RollingReservesController', () => {
  const service = { release: jest.fn(async () => ({ releaseId: 'RR-1' })) };
  const controller = new RollingReservesController(service as unknown as RollingReservesService);

  const body = { releaseId: 'RR-1', ownerId: OWNER, currency: CURRENCY, amount: '300' };

  beforeEach(() => jest.clearAllMocks());

  it('parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.release(TENANT, 'key-1', body)).resolves.toEqual({ releaseId: 'RR-1' });

    expect(service.release).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      releaseId: 'RR-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 300n,
    });
  });

  it('keeps amounts beyond 2^53 exact', async () => {
    await controller.release(TENANT, 'key-1', { ...body, amount: '9007199254740993' });

    expect(service.release).toHaveBeenCalledWith(expect.objectContaining({ amount: 9007199254740993n }));
  });

  it('declares its response message', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, RollingReservesController.prototype.release)).toBe('Rolling reserve released');
  });
});
