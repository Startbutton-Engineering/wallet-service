import { PayoutsController } from '../../../src/payouts/payouts.controller';
import { PayoutsService } from '../../../src/payouts/payouts.service';
import { payoutStatusSchema } from '../../../src/payouts/dto';
import { PAYOUT_STATUSES, PayoutStatus } from '../../../src/payouts/payout-transitions';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('PayoutsController', () => {
  const service = { status: jest.fn(async () => ({ payoutId: 'po-1' })) };
  const controller = new PayoutsController(service as unknown as PayoutsService);

  const body = {
    payoutId: 'po-1',
    ownerId: OWNER,
    currency: CURRENCY,
    amount: '10500',
    status: 'initiated' as PayoutStatus,
  };

  beforeEach(() => jest.clearAllMocks());

  it('parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.status(TENANT, 'key-1', body)).resolves.toEqual({ payoutId: 'po-1' });

    expect(service.status).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      payoutId: 'po-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 10500n,
      status: 'initiated',
    });
  });

  it.each(PAYOUT_STATUSES)('forwards the %s status verbatim', async (status) => {
    await controller.status(TENANT, 'key-1', { ...body, status });
    expect(service.status).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });

  it('labels the response', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, PayoutsController.prototype.status)).toBe(
      'Payout status applied',
    );
  });
});

describe('payoutStatusSchema', () => {
  const body = {
    payoutId: 'po-1',
    ownerId: 'm1',
    currency: 'NGN',
    amount: '10500',
    status: 'initiated',
  };

  it('accepts a well-formed body', () => {
    expect(payoutStatusSchema.parse(body)).toEqual(body);
  });

  it.each(PAYOUT_STATUSES)('accepts the %s status', (status) => {
    expect(payoutStatusSchema.safeParse({ ...body, status }).success).toBe(true);
  });

  it.each([
    ['an empty payoutId', { payoutId: '' }],
    ['an empty ownerId', { ownerId: '' }],
    ['an empty currency', { currency: '' }],
    ['a zero amount', { amount: '0' }],
    ['an unknown status', { status: 'pending' }],
  ])('rejects %s', (_label, patch) => {
    expect(payoutStatusSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});
