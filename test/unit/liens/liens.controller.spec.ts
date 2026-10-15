import { LiensController } from '../../../src/liens/liens.controller';
import { LiensService } from '../../../src/liens/liens.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('LiensController', () => {
  const service = { apply: jest.fn(async () => ({ lienId: 'LIEN-1' })) };
  const controller = new LiensController(service as unknown as LiensService);

  const body = { lienId: 'LIEN-1', ownerId: OWNER, walletType: 'payout' as const, currency: CURRENCY, amount: '400' };

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['place', (c: LiensController) => c.place(TENANT, 'key-1', body)],
    ['release', (c: LiensController) => c.release(TENANT, 'key-1', body)],
  ] as const)('%s parses the amount to a bigint and passes the context through', async (action, call) => {
    await expect(call(controller)).resolves.toEqual({ lienId: 'LIEN-1' });

    expect(service.apply).toHaveBeenCalledWith(action, {
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      lienId: 'LIEN-1',
      ownerId: OWNER,
      walletType: 'payout',
      currency: CURRENCY,
      amount: 400n,
    });
  });

  it('keeps amounts beyond 2^53 exact', async () => {
    await controller.place(TENANT, 'key-1', { ...body, amount: '9007199254740993' });

    expect(service.apply).toHaveBeenCalledWith('place', expect.objectContaining({ amount: 9007199254740993n }));
  });

  it('declares its response messages', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, LiensController.prototype.place)).toBe('Lien placed');
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, LiensController.prototype.release)).toBe('Lien released');
  });
});
