import { WalletsController } from '../../../src/wallets/wallets.controller';
import { WalletsService } from '../../../src/wallets/wallets.service';
import { RESPONSE_MESSAGE_KEY } from '../../../src/common/api-response';
import { CURRENCY, OWNER, TENANT, walletBalance } from '../../mocks';

describe('WalletsController', () => {
  const service = {
    createWallet: jest.fn(async () => walletBalance({ available: 100n })),
    transfer: jest.fn(async () => ({ operationId: 'op-1' })),
    balances: jest.fn(async () => [walletBalance({ walletType: 'collection' }), walletBalance({ walletType: 'payout' })]),
  };
  const controller = new WalletsController(service as unknown as WalletsService);

  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates the wallet and renders the balance as JSON strings', async () => {
      await expect(
        controller.create(TENANT, { ownerId: OWNER, currency: CURRENCY, walletType: 'collection' }),
      ).resolves.toMatchObject({ ownerId: OWNER, available: '100', ledger: '100' });

      expect(service.createWallet).toHaveBeenCalledWith(TENANT, OWNER, CURRENCY, 'collection');
    });
  });

  describe('transfer', () => {
    it('parses the amount to a bigint and forwards the idempotency key', async () => {
      await controller.transfer(TENANT, 'key-1', {
        transferId: 'tr-1',
        ownerId: OWNER,
        currency: CURRENCY,
        amount: '9007199254740993',
        from: 'collection',
        to: 'payout',
      });

      expect(service.transfer).toHaveBeenCalledWith({
        tenantId: TENANT,
        idempotencyKey: 'key-1',
        transferId: 'tr-1',
        ownerId: OWNER,
        currency: CURRENCY,
        amount: 9007199254740993n,
        from: 'collection',
        to: 'payout',
      });
    });

    it('returns the service result unchanged', async () => {
      await expect(
        controller.transfer(TENANT, 'key-1', {
          transferId: 'tr-1',
          ownerId: OWNER,
          currency: CURRENCY,
          amount: '1',
          from: 'payout',
          to: 'collection',
        }),
      ).resolves.toEqual({ operationId: 'op-1' });
    });
  });

  describe('balance', () => {
    it('renders every wallet the owner holds', async () => {
      await expect(controller.balance(TENANT, OWNER, CURRENCY)).resolves.toEqual([
        expect.objectContaining({ walletType: 'collection' }),
        expect.objectContaining({ walletType: 'payout' }),
      ]);
      expect(service.balances).toHaveBeenCalledWith(TENANT, OWNER, CURRENCY);
    });

    it('returns an empty list untouched', async () => {
      service.balances.mockResolvedValueOnce([]);
      await expect(controller.balance(TENANT, OWNER, CURRENCY)).resolves.toEqual([]);
    });
  });

  it('labels each response', () => {
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, WalletsController.prototype.create)).toBe(
      'Wallet created',
    );
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, WalletsController.prototype.transfer)).toBe(
      'Wallet transfer applied',
    );
    expect(Reflect.getMetadata(RESPONSE_MESSAGE_KEY, WalletsController.prototype.balance)).toBe(
      'Wallet balances retrieved',
    );
  });
});
