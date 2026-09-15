import { CollectionsController } from '../../../src/collections/collections.controller';
import { CollectionsService } from '../../../src/collections/collection.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT } from '../../mocks';

describe('CollectionsController', () => {
  const service = {
    collect: jest.fn(async () => ({ collectionId: 'col-1' })),
    settled: jest.fn(async () => ({ collectionId: 'col-1' })),
    settleBatch: jest.fn(async () => ({ operationId: 'op-1' })),
  };
  const controller = new CollectionsController(service as unknown as CollectionsService);

  const body = { collectionId: 'col-1', ownerId: OWNER, currency: CURRENCY, amount: '1000' };

  beforeEach(() => jest.clearAllMocks());

  it('collect parses the amount to a bigint and passes the context through', async () => {
    await expect(controller.collect(TENANT, 'key-1', body)).resolves.toEqual({ collectionId: 'col-1' });

    expect(service.collect).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-1',
      collectionId: 'col-1',
      ownerId: OWNER,
      currency: CURRENCY,
      amount: 1000n,
    });
  });

  it('settle routes to the settle path with the same shape', async () => {
    await controller.settle(TENANT, 'key-2', body);

    expect(service.settled).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-2', amount: 1000n }),
    );
  });

  it('keeps amounts beyond 2^53 exact', async () => {
    await controller.collect(TENANT, 'key-1', { ...body, amount: '9007199254740993' });

    expect(service.collect).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9007199254740993n }),
    );
  });

  it('settleBatch maps every item amount to a bigint', async () => {
    await expect(
      controller.settleBatch(TENANT, 'key-3', {
        ownerId: OWNER,
        currency: CURRENCY,
        items: [
          { collectionId: 'col-1', amount: '400' },
          { collectionId: 'col-2', amount: '600' },
        ],
      }),
    ).resolves.toEqual({ operationId: 'op-1' });

    expect(service.settleBatch).toHaveBeenCalledWith({
      tenantId: TENANT,
      idempotencyKey: 'key-3',
      ownerId: OWNER,
      currency: CURRENCY,
      items: [
        { collectionId: 'col-1', amount: 400n },
        { collectionId: 'col-2', amount: 600n },
      ],
    });
  });

  it('labels each response', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, CollectionsController.prototype.collect)).toBe(
      'Collection received',
    );
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, CollectionsController.prototype.settle)).toBe(
      'Collection settled',
    );
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, CollectionsController.prototype.settleBatch)).toBe(
      'Collections settled',
    );
  });
});
