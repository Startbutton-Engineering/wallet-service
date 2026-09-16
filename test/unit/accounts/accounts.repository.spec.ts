import { AccountsRepository } from '../../../src/accounts/accounts.repository';
import { AccountDoc } from '../../../src/accounts/account';
import { USER_ACCOUNT_TYPES } from '../../../src/accounts/account';
import { fromDecimal128 } from '../../../src/common/money';
import {
  CURRENCY,
  OWNER,
  TENANT,
  MockModel,
  mockModel,
  mockQuery,
  mockSession,
  userAccount,
} from '../../mocks';

describe('AccountsRepository', () => {
  let model: MockModel<AccountDoc>;
  let repo: AccountsRepository;

  beforeEach(() => {
    model = mockModel<AccountDoc>();
    repo = new AccountsRepository(model.asModel);
  });

  describe('onModuleInit', () => {
    it('creates the collection and syncs indexes', async () => {
      await repo.onModuleInit();
      expect(model.createCollection).toHaveBeenCalled();
      expect(model.syncIndexes).toHaveBeenCalled();
    });

    it('tolerates the collection already existing, so a racing replica does not break boot', async () => {
      model.createCollection.mockRejectedValue(new Error('exists'));
      await expect(repo.onModuleInit()).resolves.toBeUndefined();
    });

    it('fails boot when indexes cannot be synced, rather than serving with no unique index', async () => {
      model.syncIndexes.mockRejectedValue(new Error('E11000 duplicate key'));
      await expect(repo.onModuleInit()).rejects.toThrow('E11000');
    });
  });

  describe('ensureUserWallet', () => {
    it('upserts one zeroed sub-account per user account type', async () => {
      await repo.ensureUserWallet(TENANT, OWNER, CURRENCY, 'collection');

      const [ops] = model.bulkWrite.mock.calls[0];
      expect(ops).toHaveLength(USER_ACCOUNT_TYPES.length);
      expect(ops.map((op: any) => op.updateOne.filter)).toEqual(
        USER_ACCOUNT_TYPES.map((accountType) => ({
          tenantId: TENANT,
          ownerId: OWNER,
          currency: CURRENCY,
          walletType: 'collection',
          accountType,
        })),
      );
      expect(ops.every((op: any) => op.updateOne.filter._id === undefined)).toBe(true);
      expect(ops.every((op: any) => op.updateOne.upsert)).toBe(true);
    });

    it('only ever sets fields on insert, so an existing balance is untouched', async () => {
      await repo.ensureUserWallet(TENANT, OWNER, CURRENCY, 'payout');

      const [ops] = model.bulkWrite.mock.calls[0];
      for (const op of ops) {
        expect(Object.keys(op.updateOne.update)).toEqual(['$setOnInsert']);
        const seed = op.updateOne.update.$setOnInsert;
        expect(seed).toMatchObject({ kind: 'user', version: 0, sequence: 0 });
        // The tuple is seeded by MongoDB from the filter's equality clauses, so it must not
        // be duplicated here — one source of truth, no chance of the two drifting.
        expect(seed).not.toHaveProperty('tenantId');
        expect(seed).not.toHaveProperty('ownerId');
        expect(seed).not.toHaveProperty('accountType');
        expect(fromDecimal128(seed.balance)).toBe(0n);
        expect(seed.createdAt).toEqual(seed.updatedAt);
      }
    });

    it('passes the session through so it joins the caller transaction', async () => {
      const session = mockSession();
      await repo.ensureUserWallet(TENANT, OWNER, CURRENCY, 'collection', session.asSession);
      expect(model.bulkWrite).toHaveBeenCalledWith(expect.anything(), { session: session.asSession });
    });

    it('passes no session when called outside a transaction', async () => {
      await repo.ensureUserWallet(TENANT, OWNER, CURRENCY, 'collection');
      expect(model.bulkWrite).toHaveBeenCalledWith(expect.anything(), { session: undefined });
    });
  });

  describe('ensureSystem', () => {
    it('upserts a single zeroed system account with no owner or wallet type', async () => {
      await repo.ensureSystem(TENANT, 'external:collection', CURRENCY);

      const [filter, update, options] = model.updateOne.mock.calls[0];
      // ownerId and walletType must be in the filter: they are components of the unique
      // index, and setDefaultsOnInsert would otherwise inject a schema default for them.
      expect(filter).toEqual({
        tenantId: TENANT,
        ownerId: null,
        currency: CURRENCY,
        walletType: null,
        accountType: 'external:collection',
      });
      expect(update.$setOnInsert).toMatchObject({ kind: 'system', version: 0, sequence: 0 });
      expect(fromDecimal128(update.$setOnInsert.balance)).toBe(0n);
      expect(options).toEqual({ upsert: true, session: undefined });
    });

    it('joins a caller transaction when given a session', async () => {
      const session = mockSession();
      await repo.ensureSystem(TENANT, 'external:payout', CURRENCY, session.asSession);
      expect(model.updateOne.mock.calls[0][2]).toEqual({ upsert: true, session: session.asSession });
    });
  });

  describe('balanceBreakdown', () => {
    it('returns null when the wallet was never provisioned', async () => {
      await expect(repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection')).resolves.toBeNull();
    });

    it('maps each sub-account onto its bucket and totals the ledger', async () => {
      model.find.mockReturnValue(
        mockQuery([
          userAccount('available', 500n),
          userAccount('held-inflow', 200n),
          userAccount('held-outflow', 50n),
          userAccount('reserve', 25n),
          userAccount('refund-chargeback', -30n),
        ]),
      );

      await expect(repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection')).resolves.toEqual({
        tenantId: TENANT,
        ownerId: OWNER,
        currency: CURRENCY,
        walletType: 'collection',
        available: 500n,
        heldInflow: 200n,
        heldOutflow: 50n,
        reserve: 25n,
        ledger: 775n,
        refundChargeback: -30n,
      });
    });

    it('leaves the refund-chargeback debt out of the ledger total', async () => {
      model.find.mockReturnValue(mockQuery([userAccount('available', 100n), userAccount('refund-chargeback', -40n)]));

      const balance = await repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection');
      expect(balance?.ledger).toBe(100n);
      expect(balance?.refundChargeback).toBe(-40n);
    });

    it('defaults any sub-account the query did not return to zero', async () => {
      model.find.mockReturnValue(mockQuery([userAccount('available', 100n)]));

      await expect(repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection')).resolves.toMatchObject({
        available: 100n,
        heldInflow: 0n,
        heldOutflow: 0n,
        reserve: 0n,
        refundChargeback: 0n,
        ledger: 100n,
      });
    });

    it('queries only this owner’s user accounts for this wallet', async () => {
      model.find.mockReturnValue(mockQuery([userAccount('available', 1n)]));
      const session = mockSession();

      await repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'payout', session.asSession);

      expect(model.find).toHaveBeenCalledWith(
        { tenantId: TENANT, ownerId: OWNER, currency: CURRENCY, walletType: 'payout', kind: 'user' },
        null,
        { session: session.asSession },
      );
    });

    it('defaults available to zero when only the other sub-accounts came back', async () => {
      model.find.mockReturnValue(mockQuery([userAccount('held-inflow', 250n)]));

      await expect(repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection')).resolves.toMatchObject({
        available: 0n,
        heldInflow: 250n,
        ledger: 250n,
      });
    });

    it('carries amounts beyond 2^53 through Decimal128 without loss', async () => {
      model.find.mockReturnValue(mockQuery([userAccount('available', 9007199254740993n)]));

      await expect(repo.balanceBreakdown(TENANT, OWNER, CURRENCY, 'collection')).resolves.toMatchObject({
        available: 9007199254740993n,
      });
    });
  });
});
