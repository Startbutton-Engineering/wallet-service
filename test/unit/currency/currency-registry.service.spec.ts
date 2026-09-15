import { CurrencyRegistryService } from '../../../src/currency/currency-registry.service';
import { Currency, DEFAULT_CURRENCIES } from '../../../src/currency/currency';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { MockModel, mockModel, mockQuery } from '../../mocks';

describe('CurrencyRegistryService', () => {
  let model: MockModel<Currency>;
  let service: CurrencyRegistryService;

  beforeEach(() => {
    model = mockModel<Currency>();
    service = new CurrencyRegistryService(model.asModel);
  });

  describe('onModuleInit', () => {
    it('seeds the default currencies into an empty registry', async () => {
      await service.onModuleInit();

      expect(model.createCollection).toHaveBeenCalled();
      expect(model.syncIndexes).toHaveBeenCalled();
      expect(model.insertMany).toHaveBeenCalledWith(DEFAULT_CURRENCIES.map((c) => ({ ...c })));
    });

    it('seeds copies, not the shared DEFAULT_CURRENCIES objects', async () => {
      await service.onModuleInit();
      const [seeded] = model.insertMany.mock.calls[0];
      expect(seeded[0]).toEqual(DEFAULT_CURRENCIES[0]);
      expect(seeded[0]).not.toBe(DEFAULT_CURRENCIES[0]);
    });

    it('leaves a populated registry alone', async () => {
      model.estimatedDocumentCount.mockResolvedValue(14);
      await service.onModuleInit();
      expect(model.insertMany).not.toHaveBeenCalled();
    });

    it('tolerates createCollection and syncIndexes failing', async () => {
      model.createCollection.mockRejectedValue(new Error('exists'));
      model.syncIndexes.mockRejectedValue(new Error('busy'));
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(model.insertMany).toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('upserts by code and returns the normalised currency', async () => {
      await expect(service.register({ code: 'BTC', scale: 8, type: 'crypto' })).resolves.toEqual({
        code: 'BTC',
        scale: 8,
        type: 'crypto',
      });

      expect(model.updateOne).toHaveBeenCalledWith(
        { code: 'BTC' },
        { $set: { code: 'BTC', scale: 8, type: 'crypto' } },
        { upsert: true },
      );
    });

    it('keeps only the three known fields, dropping anything extra', async () => {
      await service.register({ code: 'BTC', scale: 8, type: 'crypto', rogue: true } as never);
      expect(model.updateOne.mock.calls[0][1].$set).toEqual({ code: 'BTC', scale: 8, type: 'crypto' });
    });
  });

  describe('list', () => {
    it('returns currencies sorted by code without the mongo _id', async () => {
      const query = mockQuery([{ code: 'NGN', scale: 2, type: 'fiat' }]);
      model.find.mockReturnValue(query);

      await expect(service.list()).resolves.toEqual([{ code: 'NGN', scale: 2, type: 'fiat' }]);
      expect(query.select).toHaveBeenCalledWith('-_id');
      expect(query.sort).toHaveBeenCalledWith({ code: 1 });
    });
  });

  describe('get', () => {
    it('returns the currency when it is registered', async () => {
      model.findOne.mockReturnValue(mockQuery({ code: 'NGN', scale: 2, type: 'fiat' }));

      await expect(service.get('NGN')).resolves.toEqual({ code: 'NGN', scale: 2, type: 'fiat' });
      expect(model.findOne).toHaveBeenCalledWith({ code: 'NGN' });
    });

    it('returns null for an unknown code rather than throwing', async () => {
      await expect(service.get('XXX')).resolves.toBeNull();
    });
  });

  describe('require', () => {
    it('returns the currency when it is registered', async () => {
      model.findOne.mockReturnValue(mockQuery({ code: 'NGN', scale: 2, type: 'fiat' }));
      await expect(service.require('NGN')).resolves.toMatchObject({ code: 'NGN' });
    });

    it('throws INVALID_CURRENCY naming the unknown code', async () => {
      await expect(service.require('XXX')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CURRENCY,
        message: 'Unknown currency: XXX',
      });
      await expect(service.require('XXX')).rejects.toBeInstanceOf(AppError);
    });
  });
});

describe('DEFAULT_CURRENCIES', () => {
  it('has no duplicate codes', () => {
    const codes = DEFAULT_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every fiat currency two minor digits and every crypto ten', () => {
    for (const currency of DEFAULT_CURRENCIES) {
      expect(currency.scale).toBe(currency.type === 'fiat' ? 2 : 10);
    }
  });
});
