import { SettlementsController } from '../../../src/settlements/settlements.controller';
import { SettlementsService } from '../../../src/settlements/settlements.service';
import {
  initiateSettlementSchema,
  listPendingSettlementsSchema,
  resolveSettlementSchema,
} from '../../../src/settlements/dto';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { OWNER, TENANT } from '../../mocks';

describe('SettlementsController', () => {
  const service = {
    initiate: jest.fn(async () => ({ settlementId: 'st-1' })),
    resolve: jest.fn(async () => ({ settlementId: 'st-1' })),
    listPending: jest.fn(async () => []),
  };
  const controller = new SettlementsController(service as unknown as SettlementsService);

  const resolveBody = { settlementId: 'st-1', ownerId: OWNER, currency: 'USD', walletType: 'collection' as const };

  beforeEach(() => jest.clearAllMocks());

  it('initiate parses the amount to a bigint and passes the context through', async () => {
    await controller.initiate(TENANT, 'key-1', { ...resolveBody, amount: '10500' });

    expect(service.initiate).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      settlementId: 'st-1',
      ownerId: OWNER,
      currency: 'USD',
      amount: 10500n,
      walletType: 'collection',
    });
  });

  it.each([
    ['success', 'success'],
    ['fail', 'failed'],
  ] as const)('%s resolves with status %s', async (handler, status) => {
    await controller[handler](TENANT, 'key-2', resolveBody);

    expect(service.resolve).toHaveBeenCalledWith({ tenantId: TENANT, idempotencyKey: 'key-2', ...resolveBody, status });
  });

  it('pending forwards the limit', async () => {
    await controller.pending(TENANT, { limit: 5 });
    expect(service.listPending).toHaveBeenCalledWith(TENANT, 5);
  });

  it.each([
    ['initiate', 'Settlement initiated'],
    ['success', 'Settlement succeeded'],
    ['fail', 'Settlement failed'],
    ['pending', 'Pending settlements retrieved'],
  ] as const)('labels the %s response', (handler, message) => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, SettlementsController.prototype[handler])).toBe(message);
  });
});

describe('settlement schemas', () => {
  const body = { settlementId: 'st-1', ownerId: 'm1', currency: 'USD', amount: '10500' };

  it('initiate defaults walletType to collection', () => {
    expect(initiateSettlementSchema.parse(body)).toEqual({ ...body, walletType: 'collection' });
  });

  it.each([
    ['an empty settlementId', { settlementId: '' }],
    ['an empty ownerId', { ownerId: '' }],
    ['an empty currency', { currency: '' }],
    ['a zero amount', { amount: '0' }],
    ['a decimal amount', { amount: '10.5' }],
    ['an unknown walletType', { walletType: 'savings' }],
  ])('initiate rejects %s', (_label, patch) => {
    expect(initiateSettlementSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });

  it('resolve takes no amount and defaults walletType to collection', () => {
    const { amount: _amount, ...resolve } = body;
    expect(resolveSettlementSchema.parse(body)).toEqual({ ...resolve, walletType: 'collection' });
  });

  it('pending coerces and bounds the limit', () => {
    expect(listPendingSettlementsSchema.parse({ limit: '20' })).toEqual({ limit: 20 });
    expect(listPendingSettlementsSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listPendingSettlementsSchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});
