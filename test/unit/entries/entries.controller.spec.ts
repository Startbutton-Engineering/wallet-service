import { EntriesController } from '../../../src/entries/entries.controller';
import { EntriesService } from '../../../src/entries/entries.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { TENANT } from '../../mocks';

describe('EntriesController', () => {
  const service = {
    get: jest.fn(async () => ({ entryId: 'e1' })),
    lookup: jest.fn(async () => ({ items: [] })),
  };
  const controller = new EntriesController(service as unknown as EntriesService);

  beforeEach(() => jest.clearAllMocks());

  it('get forwards the tenant and id', async () => {
    await expect(controller.get(TENANT, 'e1')).resolves.toEqual({ entryId: 'e1' });
    expect(service.get).toHaveBeenCalledWith(TENANT, 'e1');
  });

  it('lookup forwards the parsed lookup', async () => {
    await expect(controller.lookup(TENANT, { by: 'payoutId', value: 'po-1' })).resolves.toEqual({ items: [] });
    expect(service.lookup).toHaveBeenCalledWith(TENANT, { by: 'payoutId', value: 'po-1' });
  });

  it('labels each response', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, EntriesController.prototype.get)).toBe('Entry retrieved');
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, EntriesController.prototype.lookup)).toBe('Entries retrieved');
  });
});
