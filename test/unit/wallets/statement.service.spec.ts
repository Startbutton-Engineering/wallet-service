import { Types } from 'mongoose';
import { StatementParams, StatementService } from '../../../src/wallets/statement.service';
import { AccountsRepository } from '../../../src/accounts/accounts.repository';
import { PostingsRepository } from '../../../src/ledger/postings.repository';
import { CurrencyRegistryService } from '../../../src/currency/currency-registry.service';
import { PostingDoc } from '../../../src/ledger/types';
import { cursorFingerprint, decodeCursor, encodeCursor } from '../../../src/common/cursor';
import { AppError, ErrorCode } from '../../../src/common/errors';
import { CURRENCY, NGN, OWNER, TENANT, userAccount } from '../../mocks';

function posting(sequence: number, overrides: Partial<PostingDoc> = {}): PostingDoc {
  return {
    _id: new Types.ObjectId(),
    tenantId: TENANT,
    operationId: new Types.ObjectId(),
    entryId: new Types.ObjectId(),
    accountId: new Types.ObjectId(),
    ownerId: OWNER,
    walletType: 'collection',
    accountType: 'available',
    kind: 'user',
    currency: CURRENCY,
    direction: 'credit',
    amount: Types.Decimal128.fromString('100'),
    balanceAfter: Types.Decimal128.fromString(String(sequence * 100)),
    sequence,
    operationType: 'collection.settle',
    reference: `col-${sequence}`,
    actor: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)),
    ...overrides,
  };
}

describe('StatementService', () => {
  const available = userAccount('available', 0n);
  const heldInflow = userAccount('held-inflow', 0n);

  let currencies: { require: jest.Mock };
  let accounts: { findUserAccounts: jest.Mock };
  let postings: { sequenceBounds: jest.Mock; pageByAccount: jest.Mock; pageByOwner: jest.Mock };
  let service: StatementService;

  const params = (overrides: Partial<StatementParams> = {}): StatementParams => ({
    tenantId: TENANT,
    ownerId: OWNER,
    currency: CURRENCY,
    limit: 2,
    ...overrides,
  });

  const fingerprintOf = (p: StatementParams) =>
    cursorFingerprint([
      p.ownerId, p.currency, p.walletType ?? null, p.accountType ?? null,
      p.from?.toISOString() ?? null, p.to?.toISOString() ?? null,
    ]);

  beforeEach(() => {
    currencies = { require: jest.fn(async () => NGN) };
    accounts = { findUserAccounts: jest.fn(async () => [available, heldInflow]) };
    postings = {
      sequenceBounds: jest.fn(async () => ({})),
      pageByAccount: jest.fn(async () => []),
      pageByOwner: jest.fn(async () => []),
    };
    service = new StatementService(
      currencies as unknown as CurrencyRegistryService,
      accounts as unknown as AccountsRepository,
      postings as unknown as PostingsRepository,
    );
  });

  it('validates the currency first', async () => {
    currencies.require.mockRejectedValue(AppError.invalidCurrency('XXX'));
    await expect(service.statement(params({ currency: 'XXX' }))).rejects.toMatchObject({
      code: ErrorCode.INVALID_CURRENCY,
    });
    expect(accounts.findUserAccounts).not.toHaveBeenCalled();
  });

  describe('not found', () => {
    it('404s an owner with no wallet in the currency', async () => {
      accounts.findUserAccounts.mockResolvedValue([]);
      await expect(service.statement(params())).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        httpStatus: 404,
        details: { ownerId: OWNER, currency: CURRENCY },
      });
    });

    it('404s a wallet type the owner was never provisioned for', async () => {
      accounts.findUserAccounts.mockResolvedValue([]);
      await expect(service.statement(params({ walletType: 'payout' }))).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        details: { walletType: 'payout' },
      });
      expect(accounts.findUserAccounts).toHaveBeenCalledWith(TENANT, OWNER, CURRENCY, 'payout');
    });

    it('404s a sub-account missing from an otherwise provisioned wallet', async () => {
      await expect(
        service.statement(params({ walletType: 'collection', accountType: 'reserve' })),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND, details: { accountType: 'reserve' } });
    });
  });

  describe('single account (walletType + accountType)', () => {
    const single = () => params({ walletType: 'collection', accountType: 'available' });

    it('pages that account by sequence, fetching one extra row to detect the next page', async () => {
      postings.pageByAccount.mockResolvedValue([posting(1), posting(2), posting(3)]);

      const page = await service.statement(single());

      expect(postings.pageByAccount).toHaveBeenCalledWith({ accountId: available._id, afterSeq: undefined, limit: 3 });
      expect(page.items.map((r) => r.sequence)).toEqual([1, 2]);
      expect(decodeCursor(page.nextCursor!, fingerprintOf(single()))).toEqual({ mode: 'sequence', sequence: 2 });
    });

    it('resumes after the cursor and stops when the last page is short', async () => {
      postings.pageByAccount.mockResolvedValue([posting(3)]);
      const cursor = encodeCursor({ mode: 'sequence', sequence: 2 }, fingerprintOf(single()));

      const page = await service.statement({ ...single(), cursor });

      expect(postings.pageByAccount).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 2 }));
      expect(page).toMatchObject({ nextCursor: null });
      expect(page.items).toHaveLength(1);
    });

    it('turns the time window into a sequence window', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      const to = new Date('2026-09-02T00:00:00.000Z');
      postings.sequenceBounds.mockResolvedValue({ fromSeq: 5, toSeq: 8 });

      await service.statement({ ...single(), from, to });

      expect(postings.sequenceBounds).toHaveBeenCalledWith(available._id, from, to);
      expect(postings.pageByAccount).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 5, toSeq: 8 }));
    });

    it('returns an empty page without paging when the window holds nothing', async () => {
      postings.sequenceBounds.mockResolvedValue(null);
      await expect(service.statement(single())).resolves.toEqual({ items: [], nextCursor: null });
      expect(postings.pageByAccount).not.toHaveBeenCalled();
    });

    it('rejects a time cursor', async () => {
      const cursor = encodeCursor(
        { mode: 'time', createdAt: new Date(), id: new Types.ObjectId().toHexString() },
        fingerprintOf(single()),
      );
      await expect(service.statement({ ...single(), cursor })).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
    });
  });

  describe('merged sub-accounts', () => {
    it('pages the whole owner/currency by (createdAt, _id) with every filter passed through', async () => {
      const rows = [posting(1), posting(2, { walletType: 'payout' }), posting(3)];
      postings.pageByOwner.mockResolvedValue(rows);
      const from = new Date('2026-09-01T00:00:00.000Z');

      const page = await service.statement(params({ from, accountType: 'available' }));

      expect(postings.pageByOwner).toHaveBeenCalledWith({
        tenantId: TENANT,
        ownerId: OWNER,
        currency: CURRENCY,
        walletType: undefined,
        accountType: 'available',
        from,
        to: undefined,
        after: undefined,
        limit: 3,
      });
      expect(page.items.map((r) => r.walletType)).toEqual(['collection', 'payout']);
      expect(decodeCursor(page.nextCursor!, fingerprintOf(params({ from, accountType: 'available' })))).toEqual({
        mode: 'time',
        createdAt: rows[1].createdAt,
        id: rows[1]._id.toHexString(),
      });
    });

    it('resumes after the cursor position', async () => {
      const at = { createdAt: new Date('2026-09-01T00:00:02.000Z'), id: new Types.ObjectId().toHexString() };
      const cursor = encodeCursor({ mode: 'time', ...at }, fingerprintOf(params()));

      const page = await service.statement(params({ cursor }));

      expect(postings.pageByOwner).toHaveBeenCalledWith(expect.objectContaining({ after: at }));
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it('rejects a sequence cursor', async () => {
      const cursor = encodeCursor({ mode: 'sequence', sequence: 1 }, fingerprintOf(params()));
      await expect(service.statement(params({ cursor }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
    });

    it('rejects a cursor minted under other filters', async () => {
      const cursor = encodeCursor({ mode: 'sequence', sequence: 1 }, fingerprintOf(params({ walletType: 'payout' })));
      await expect(service.statement(params({ cursor }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
      expect(postings.pageByOwner).not.toHaveBeenCalled();
    });
  });

  it('renders rows with string amounts and ISO timestamps', async () => {
    const row = posting(7, { balanceAfter: null, sequence: null });
    postings.pageByOwner.mockResolvedValue([row]);

    const { items } = await service.statement(params());

    expect(items[0]).toEqual({
      postingId: row._id.toHexString(),
      entryId: row.entryId.toHexString(),
      operationId: row.operationId.toHexString(),
      operationType: 'collection.settle',
      reference: 'col-7',
      walletType: 'collection',
      accountType: 'available',
      direction: 'credit',
      amount: '100',
      balanceAfter: null,
      sequence: null,
      createdAt: row.createdAt.toISOString(),
    });
  });
});
