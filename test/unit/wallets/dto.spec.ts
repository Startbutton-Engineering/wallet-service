import { balanceToJson, createWalletSchema, walletTransferSchema } from '../../../src/wallets/dto';
import { walletBalance } from '../../mocks';

describe('balanceToJson', () => {
  it('renders every bucket as a decimal string and drops the tenant', () => {
    const json = balanceToJson(
      walletBalance({
        available: 500n,
        heldInflow: 200n,
        heldOutflow: 50n,
        reserve: 25n,
        refundChargeback: -30n,
      }),
    );

    expect(json).toEqual({
      ownerId: 'm1',
      currency: 'NGN',
      walletType: 'collection',
      available: '500',
      heldInflow: '200',
      heldOutflow: '50',
      reserve: '25',
      ledger: '775',
      refundChargeback: '-30',
    });
    expect(json).not.toHaveProperty('tenantId');
  });

  it('keeps amounts beyond 2^53 exact', () => {
    expect(balanceToJson(walletBalance({ available: 9007199254740993n })).available).toBe(
      '9007199254740993',
    );
  });

  it('renders zero balances as "0", never as an empty string', () => {
    expect(balanceToJson(walletBalance())).toMatchObject({ available: '0', ledger: '0' });
  });
});

describe('createWalletSchema', () => {
  it('accepts either wallet type', () => {
    expect(createWalletSchema.parse({ ownerId: 'm1', currency: 'NGN', walletType: 'collection' })).toEqual({
      ownerId: 'm1',
      currency: 'NGN',
      walletType: 'collection',
    });
    expect(
      createWalletSchema.safeParse({ ownerId: 'm1', currency: 'NGN', walletType: 'payout' }).success,
    ).toBe(true);
  });

  it.each([
    ['an empty ownerId', { ownerId: '', currency: 'NGN', walletType: 'collection' }],
    ['an empty currency', { ownerId: 'm1', currency: '', walletType: 'collection' }],
    ['an unknown wallet type', { ownerId: 'm1', currency: 'NGN', walletType: 'savings' }],
    ['a missing wallet type', { ownerId: 'm1', currency: 'NGN' }],
  ])('rejects %s', (_label, body) => {
    expect(createWalletSchema.safeParse(body).success).toBe(false);
  });
});

describe('walletTransferSchema', () => {
  const body = {
    transferId: 'tr-1',
    ownerId: 'm1',
    currency: 'NGN',
    amount: '1000',
    from: 'collection',
    to: 'payout',
  };

  it('accepts a transfer between two different wallet types', () => {
    expect(walletTransferSchema.parse(body)).toEqual(body);
  });

  it('accepts the reverse direction too', () => {
    expect(walletTransferSchema.safeParse({ ...body, from: 'payout', to: 'collection' }).success).toBe(true);
  });

  it('rejects a transfer to the same wallet type, pointing at `to`', () => {
    const result = walletTransferSchema.safeParse({ ...body, to: 'collection' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'from and to must be different wallet types',
    });
  });

  it.each([
    ['an empty transferId', { transferId: '' }],
    ['an empty ownerId', { ownerId: '' }],
    ['an empty currency', { currency: '' }],
    ['a zero amount', { amount: '0' }],
    ['an unknown source wallet', { from: 'savings' }],
  ])('rejects %s', (_label, patch) => {
    expect(walletTransferSchema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});
