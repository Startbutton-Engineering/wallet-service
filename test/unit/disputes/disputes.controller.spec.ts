import { DisputesController } from '../../../src/disputes/disputes.controller';
import { DisputesService } from '../../../src/disputes/disputes.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('DisputesController', () => {
  const service = { accept: jest.fn(async () => ({ disputeId: 'dsp-1' })) };
  const controller = new DisputesController(service as unknown as DisputesService);

  const body = { disputeId: 'dsp-1', ownerId: OWNER, currency: CURRENCY, amount: '150', allowOverdraft: true };

  beforeEach(() => jest.clearAllMocks());

  it('parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.accept(TENANT, 'key-1', body)).resolves.toEqual({ disputeId: 'dsp-1' });

    expect(service.accept).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      disputeId: 'dsp-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 150n,
      allowOverdraft: true,
    });
  });

  it('keeps amounts beyond 2^53 exact', async () => {
    await controller.accept(TENANT, 'key-1', { ...body, amount: '9007199254740993' });

    expect(service.accept).toHaveBeenCalledWith(expect.objectContaining({ amount: 9007199254740993n }));
  });

  it('declares its response message', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, DisputesController.prototype.accept)).toBe('Dispute accepted');
  });
});
