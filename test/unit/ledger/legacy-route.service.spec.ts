import { accountRef, System } from '../../../src/accounts/account';
import { LegacyEffect, LegacyRouteService, LegacyWallet, planLegacyEffect } from '../../../src/ledger/legacy-route.service';
import { walletBalance } from '../../mocks/fixtures';

describe('planLegacyEffect', () => {
  const wallet: LegacyWallet = { ownerId: 'm1', walletType: 'payout', currency: 'NGN' };
  const base: LegacyEffect = { direction: 'credit', updatedField: 'availableBalance', amount: 100n };
  const user = (type: Parameters<typeof accountRef.user>[3]) => accountRef.user('m1', 'NGN', 'payout', type);
  const external = accountRef.system(System.legacy, 'NGN');

  it.each([
    ['credit', 'availableBalance', user('legacy-pending'), user('available')],
    ['debit', 'availableBalance', user('available'), user('legacy-pending')],
    ['credit', 'ledgerBalance', external, user('legacy-pending')],
    ['debit', 'ledgerBalance', user('legacy-pending'), external],
    ['credit', 'both', external, user('available')],
    ['debit', 'both', user('available'), external],
    ['credit', 'refundsOrChargeBackBalance', external, user('refund-chargeback')],
    ['debit', 'refundsOrChargeBackBalance', user('refund-chargeback'), external],
    ['credit', 'rollingReserveOverdraftBalance', external, user('reserve-overdraft')],
    ['debit', 'rollingReserveOverdraftBalance', user('reserve-overdraft'), external],
  ] as const)('%s %s moves %j → %j', (direction, updatedField, from, to) => {
    expect(planLegacyEffect(wallet, { ...base, direction, updatedField })).toMatchObject({ from, to });
  });

  it('guards available only on a debit that takes from it', () => {
    expect(planLegacyEffect(wallet, { ...base, direction: 'debit', updatedField: 'availableBalance' }).guardNegative).toEqual([user('available')]);
    expect(planLegacyEffect(wallet, { ...base, direction: 'debit', updatedField: 'both' }).guardNegative).toEqual([user('available')]);
    expect(planLegacyEffect(wallet, { ...base, direction: 'debit', updatedField: 'ledgerBalance' }).guardNegative).toEqual([]);
    expect(planLegacyEffect(wallet, { ...base, direction: 'credit', updatedField: 'availableBalance' }).guardNegative).toEqual([]);
  });

  it('lets a debit overdraw when legacy allowed it', () => {
    expect(planLegacyEffect(wallet, { ...base, direction: 'debit', updatedField: 'both', allowOverdraft: true }).guardNegative).toEqual([]);
  });
});

describe('LegacyRouteService', () => {
  const ownerId = '64f0c2a1b2c3d4e5f6a7b8c9';
  const cutoverAt = new Date('2026-10-14');
  const before = new Date('2026-10-01');

  function setup({ cut = cutoverAt as Date | null, records = [] as Record<string, unknown>[], balance = walletBalance() } = {}) {
    const find = jest.fn(() => ({ toArray: async () => records }));
    const legacyWallets = { cutoverAt: jest.fn(async () => cut), collection: jest.fn(() => ({ find })) };
    const currencies = { require: jest.fn(async (code: string) => ({ code, scale: code === 'USDT' ? 10 : 2, type: 'fiat' })) };
    const service = new LegacyRouteService(legacyWallets as never, currencies as never);
    const ctx = { readBalance: jest.fn(async () => balance) } as never;
    const post = { operationId: 'op1', entryIds: ['e1', 'e2'], accountBalance: jest.fn(async () => balance) };
    const run = (operationType: string, requestPayload: Record<string, unknown>) =>
      service.plan({ operationType, requestPayload, tenantId: 't', idempotencyKey: 'k', generateLedgerOps: jest.fn() } as never, ctx);
    return { service, run, post, find, legacyWallets };
  }
  const postingsOf = (op: any) => op.entries.flatMap((e: any) => e.postings.map((p: any) => `${p.direction}:${p.account.accountType ?? p.account.name}:${p.amount}`));

  it('leaves operations it has no route for, owners not cut over, and records made after cutover alone', async () => {
    expect(await setup().run('lien.place', { ownerId })).toBeNull();
    expect(await setup({ cut: null }).run('payout.success', { ownerId, payoutId: 'P1', currency: 'NGN', amount: '100' })).toBeNull();
    expect(await setup({ records: [] }).run('payout.success', { ownerId, payoutId: 'P1', currency: 'NGN', amount: '100' })).toBeNull();
  });

  it('applies a pre-cutover payout success as legacy debited ledgerBalance, in the payout response shape', async () => {
    const { run, post } = setup({ records: [{ transactionReference: 'P1', createdAt: before }] });
    const op: any = await run('payout.success', { ownerId, payoutId: 'P1', currency: 'NGN', amount: '100', status: 'success' });

    expect(postingsOf(op)).toEqual(['debit:legacy-pending:100', 'credit:external:legacy:100']);
    expect(op.entries[0]).toMatchObject({ reference: 'P1', operationType: 'legacy.effect', metadata: { nativeOperation: 'payout.success' } });
    expect(await op.buildResponse(post)).toMatchObject({ operationId: 'op1', entryId: 'e1', payoutId: 'P1', status: 'success' });
    expect(await op.buildEvent(post)).toMatchObject({ type: 'LegacyEffectApplied', payload: { nativeOperation: 'payout.success', reference: 'P1' } });
  });

  it('takes a settlement resolution amount from back-end\'s record', async () => {
    const { run, post } = setup({ records: [{ transactionReference: 'S1', createdAt: before, fromAmount: 12.5 }] });
    const op: any = await run('settlement.failed', { ownerId, settlementId: 'S1', currency: 'NGN', walletType: 'collection', status: 'failed' });

    expect(postingsOf(op)).toEqual(['debit:legacy-pending:1250', 'credit:available:1250']);
    expect(await op.buildResponse(post)).toMatchObject({ amount: '1250', status: 'failed' });
  });

  it('converts a pre-cutover conversion initiate at the request rate, one entry per currency', async () => {
    const { run, post } = setup({ records: [{ transactionReference: 'C1', createdAt: before }] });
    const op: any = await run('conversion.initiate', {
      ownerId, conversionId: 'C1', fromCurrency: 'NGN', toCurrency: 'USDT', fromAmount: '100000', rate: '0.0005', walletType: 'collection',
    });

    expect(op.entries.map((e: any) => e.currency)).toEqual(['NGN', 'USDT']);
    expect(postingsOf(op)).toEqual([
      'debit:available:100000', 'credit:legacy-pending:100000',
      'debit:external:legacy:5000000000', 'credit:legacy-pending:5000000000',
    ]);
    expect(await op.buildResponse(post)).toMatchObject({ status: 'initiated', rate: '0.0005', toAmount: '5000000000' });
  });

  it('resolves a conversion with both amounts from the record', async () => {
    const { run } = setup({ records: [{ transactionReference: 'C2', createdAt: before, fromAmount: 10, toAmount: 0.25 }] });
    const op: any = await run('conversion.reject', { ownerId, conversionId: 'C2', fromCurrency: 'NGN', toCurrency: 'USDT', walletType: 'collection', status: 'rejected' });

    expect(postingsOf(op)).toEqual([
      'debit:legacy-pending:1000', 'credit:available:1000',
      'debit:legacy-pending:2500000000', 'credit:external:legacy:2500000000',
    ]);
  });

  it('repays a refund deficit from a collection credit first, and reports it', async () => {
    const { run, post } = setup({ records: [{ transactionReference: 'COL1', createdAt: before }], balance: walletBalance({ refundChargeback: -30n }) });
    const op: any = await run('collection.settle', { ownerId, collectionId: 'COL1', currency: 'NGN', amount: '100' });

    expect(postingsOf(op)).toEqual([
      'debit:external:legacy:30', 'credit:refund-chargeback:30',
      'debit:legacy-pending:70', 'credit:available:70',
    ]);
    expect(await op.buildResponse(post)).toMatchObject({ settledToDebit: '30', amountToCredit: '70' });
  });

  it('finds a refund in back-end\'s refunds by its reference', async () => {
    const { run, find, legacyWallets } = setup({ records: [{ reference: 'R1', createdAt: before }], balance: walletBalance({ available: 1000n }) });
    const op: any = await run('refund.pending', { ownerId, refundId: 'R1', currency: 'NGN', amount: '100', status: 'pending' });

    expect(legacyWallets.collection).toHaveBeenCalledWith('refunds');
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ reference: { $in: ['R1'] } }), expect.anything());
    expect(postingsOf(op)).toEqual(['debit:available:100', 'credit:external:legacy:100']);
  });

  it('puts the shortfall of an overdrawing refund on refund-chargeback', async () => {
    const { run } = setup({ records: [{ reference: 'R2', createdAt: before }], balance: walletBalance({ available: 40n }) });
    const op: any = await run('refund.pending', { ownerId, refundId: 'R2', currency: 'NGN', amount: '100', status: 'pending', allowOverdraft: true });

    expect(postingsOf(op)).toEqual([
      'debit:available:40', 'credit:external:legacy:40',
      'debit:refund-chargeback:60', 'credit:external:legacy:60',
    ]);
    expect(op.guardNegative).toEqual([]);
  });

  it('moves nothing of the owner\'s on a refund success, and credits both balances back on failure', async () => {
    const records = [{ reference: 'R3', createdAt: before }];
    expect((await setup({ records }).run('refund.success', { ownerId, refundId: 'R3', currency: 'NGN', amount: '100', status: 'success' }) as any).entries).toEqual([]);
    expect(postingsOf(await setup({ records }).run('refund.failed', { ownerId, refundId: 'R3', currency: 'NGN', amount: '100', status: 'failed' })))
      .toEqual(['debit:external:legacy:100', 'credit:available:100']);
  });

  it.each([
    ['payout.initiate', 'payoutId', ['debit:available:100', 'credit:legacy-pending:100']],
    ['payout.failed', 'payoutId', ['debit:legacy-pending:100', 'credit:available:100']],
    ['payout.reverse', 'payoutId', ['debit:external:legacy:100', 'credit:available:100']],
    ['payout.reverse-failed', 'payoutId', ['debit:available:100', 'credit:external:legacy:100']],
    ['collection.receive', 'collectionId', ['debit:external:legacy:100', 'credit:legacy-pending:100']],
    ['settlement.initiate', 'settlementId', ['debit:available:100', 'credit:legacy-pending:100']],
    ['settlement.success', 'settlementId', ['debit:legacy-pending:100', 'credit:external:legacy:100']],
    ['conversion.approve', 'conversionId', ['debit:legacy-pending:100', 'credit:external:legacy:100', 'debit:legacy-pending:100', 'credit:available:100']],
    ['topup.credit', 'topupId', ['debit:external:legacy:100', 'credit:available:100']],
    ['refund.fee.initiate', 'transferReference', ['debit:available:100', 'credit:legacy-pending:100']],
    ['refund.fee.success', 'transferReference', ['debit:legacy-pending:100', 'credit:external:legacy:100']],
    ['refund.fee.reverse', 'transferReference', ['debit:legacy-pending:100', 'credit:available:100']],
    ['refund.fee.reverse-failed', 'transferReference', ['debit:available:100', 'credit:external:legacy:100']],
  ])('%s applies legacy\'s change', async (operationType, idField, expected) => {
    const { run, post } = setup({ records: [{ transactionReference: 'X1', createdAt: before, fromAmount: 1, toAmount: 1 }] });
    const op: any = await run(operationType, {
      ownerId, [idField]: 'X1', currency: 'NGN', amount: '100', walletType: 'collection', fromCurrency: 'NGN', toCurrency: 'NGN', status: 's',
    });
    expect(postingsOf(op)).toEqual(expected);
    expect(await op.buildResponse(post)).toMatchObject({ operationId: 'op1' });
  });
});
