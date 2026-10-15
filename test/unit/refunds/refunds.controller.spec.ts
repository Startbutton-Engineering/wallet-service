import { RefundsController } from '../../../src/refunds/refunds.controller';
import { RefundsService } from '../../../src/refunds/refunds.service';
import { refundFeeStatusSchema, refundStatusSchema } from '../../../src/refunds/dto';
import { REFUND_FEE_STATUSES } from '../../../src/refunds/refund-fee-transitions';
import { REFUND_STATUSES, RefundStatus } from '../../../src/refunds/refund-transitions';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('RefundsController', () => {
  const service = {
    status: jest.fn(async () => ({ refundId: 'rf-1' })),
    feeStatus: jest.fn(async () => ({ transferReference: 'trf_rf-1' })),
  };
  const controller = new RefundsController(service as unknown as RefundsService);

  const body = {
    refundId: 'rf-1',
    ownerId: OWNER,
    currency: CURRENCY,
    amount: '150',
    status: 'pending' as RefundStatus,
    allowOverdraft: true,
  };

  beforeEach(() => jest.clearAllMocks());

  it('parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.status(TENANT, 'key-1', body)).resolves.toEqual({ refundId: 'rf-1' });

    expect(service.status).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      refundId: 'rf-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 150n,
      status: 'pending',
      allowOverdraft: true,
    });
  });

  it.each(REFUND_STATUSES)('forwards the %s status verbatim', async (status) => {
    await controller.status(TENANT, 'key-1', { ...body, status });
    expect(service.status).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });

  it('labels the response', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, RefundsController.prototype.status)).toBe(
      'Refund status applied',
    );
  });

  describe('feeStatus', () => {
    const feeBody = {
      refundId: 'rf-1',
      transferReference: 'trf_rf-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: '50',
      status: 'initiated' as const,
    };

    it('parses the amount to a bigint and passes the context through', async () => {
      await expect(controller.feeStatus(TENANT, 'key-1', feeBody)).resolves.toEqual({ transferReference: 'trf_rf-1' });

      expect(service.feeStatus).toHaveBeenCalledWith({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        refundId: 'rf-1',
        transferReference: 'trf_rf-1',
        ownerId: OWNER,
        currency: CURRENCY,
        amount: 50n,
        status: 'initiated',
      });
    });

    it('labels the response', () => {
      expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, RefundsController.prototype.feeStatus)).toBe(
        'Refund fee status applied',
      );
    });
  });
});

describe('refundStatusSchema', () => {
  const body = { refundId: 'rf-1', ownerId: 'm1', currency: 'NGN', amount: '150', status: 'pending' };

  it('defaults allowOverdraft to false', () => {
    expect(refundStatusSchema.parse(body)).toEqual({ ...body, allowOverdraft: false });
  });

  it('keeps an explicit allowOverdraft', () => {
    expect(refundStatusSchema.parse({ ...body, allowOverdraft: true }).allowOverdraft).toBe(true);
  });

  it.each(REFUND_STATUSES)('accepts the %s status', (status) => {
    expect(refundStatusSchema.safeParse({ ...body, status }).success).toBe(true);
  });

  it.each([
    ['an empty refundId', { refundId: '' }],
    ['an empty ownerId', { ownerId: '' }],
    ['an empty currency', { currency: '' }],
    ['a zero amount', { amount: '0' }],
    ['an unknown status', { status: 'initiated' }],
    ['a non-boolean allowOverdraft', { allowOverdraft: 'yes' }],
  ])('rejects %s', (_label, patch) => {
    expect(refundStatusSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});

describe('refundFeeStatusSchema', () => {
  const body = {
    refundId: 'rf-1',
    transferReference: 'trf_rf-1',
    ownerId: 'm1',
    currency: 'NGN',
    amount: '50',
    status: 'initiated',
  };

  it.each(REFUND_FEE_STATUSES)('accepts the %s status', (status) => {
    expect(refundFeeStatusSchema.parse({ ...body, status })).toEqual({ ...body, status });
  });

  it.each([
    ['an empty refundId', { refundId: '' }],
    ['a missing transferReference', { transferReference: undefined }],
    ['an empty transferReference', { transferReference: '' }],
    ['a zero amount', { amount: '0' }],
    ['an unknown status', { status: 'failed' }],
  ])('rejects %s', (_label, patch) => {
    expect(refundFeeStatusSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});
