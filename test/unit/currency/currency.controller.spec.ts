import { CurrencyController } from '../../../src/currency/currency.controller';
import { registerCurrencySchema } from '../../../src/currency/dto';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { mockCurrencyRegistry } from '../../mocks/ledger.mock';

describe('CurrencyController', () => {
  const registry = mockCurrencyRegistry({ known: ['NGN', 'USD'] });
  const controller = new CurrencyController(registry.asService);

  beforeEach(() => jest.clearAllMocks());

  it('lists what the registry holds', async () => {
    await expect(controller.list()).resolves.toEqual([
      { code: 'NGN', scale: 2, type: 'fiat' },
      { code: 'USD', scale: 2, type: 'fiat' },
    ]);
  });

  it('passes the validated body straight to register', async () => {
    const body = { code: 'BTC', scale: 8, type: 'crypto' as const };
    await expect(controller.register(body)).resolves.toEqual(body);
    expect(registry.register).toHaveBeenCalledWith(body);
  });

  it('labels both responses', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, CurrencyController.prototype.list)).toBe(
      'Currencies retrieved',
    );
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, CurrencyController.prototype.register)).toBe(
      'Currency registered',
    );
  });
});

describe('registerCurrencySchema', () => {
  it('accepts a well-formed fiat and crypto currency', () => {
    expect(registerCurrencySchema.parse({ code: 'NGN', scale: 2, type: 'fiat' })).toEqual({
      code: 'NGN',
      scale: 2,
      type: 'fiat',
    });
    expect(registerCurrencySchema.safeParse({ code: 'BTC', scale: 8, type: 'crypto' }).success).toBe(true);
  });

  it.each([
    ['an empty code', { code: '', scale: 2, type: 'fiat' }],
    ['a missing code', { scale: 2, type: 'fiat' }],
    ['a fractional scale', { code: 'NGN', scale: 2.5, type: 'fiat' }],
    ['a negative scale', { code: 'NGN', scale: -1, type: 'fiat' }],
    ['a scale above 30', { code: 'NGN', scale: 31, type: 'fiat' }],
    ['an unknown type', { code: 'NGN', scale: 2, type: 'points' }],
    ['a string scale', { code: 'NGN', scale: '2', type: 'fiat' }],
  ])('rejects %s', (_label, body) => {
    expect(registerCurrencySchema.safeParse(body).success).toBe(false);
  });

  it('accepts the boundary scales 0 and 30', () => {
    expect(registerCurrencySchema.safeParse({ code: 'JPY', scale: 0, type: 'fiat' }).success).toBe(true);
    expect(registerCurrencySchema.safeParse({ code: 'WEI', scale: 30, type: 'crypto' }).success).toBe(true);
  });
});
