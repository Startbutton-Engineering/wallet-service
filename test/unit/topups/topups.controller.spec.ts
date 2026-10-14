import { TopupsController } from '../../../src/topups/topups.controller';
import { TopupsService } from '../../../src/topups/topups.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('TopupsController', () => {
  const service = { credit: jest.fn(async () => ({ topupId: 'tp-1' })) };
  const controller = new TopupsController(service as unknown as TopupsService);

  const body = { topupId: 'tp-1', ownerId: OWNER, currency: CURRENCY, amount: '1000' };

  beforeEach(() => jest.clearAllMocks());

  it('credit parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.credit(TENANT, 'key-1', body)).resolves.toEqual({ topupId: 'tp-1' });

    expect(service.credit).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      topupId: 'tp-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 1000n,
    });
  });

  it('keeps amounts beyond 2^53 exact', async () => {
    await controller.credit(TENANT, 'key-1', { ...body, amount: '9007199254740993' });

    expect(service.credit).toHaveBeenCalledWith(expect.objectContaining({ amount: 9007199254740993n }));
  });

  it('declares its response message', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, TopupsController.prototype.credit)).toBe('Topup credited');
  });
});
