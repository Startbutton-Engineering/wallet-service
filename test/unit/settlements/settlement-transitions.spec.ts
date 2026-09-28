import { AccountRef, accountRef, refKey } from "../../../src/accounts/account";
import { AppError, ErrorCode } from "../../../src/common/errors";
import { PrePostContext } from "../../../src/ledger/ledger.service";
import { Direction, EntryI, signedDelta } from "../../../src/ledger/types";
import {
  InitiateParams,
  ResolveParams,
  SETTLEMENT_TRANSITIONS,
  SettlementOperation,
  SettlementResolution,
  planInitiate,
} from "../../../src/settlements/settlement-transitions";

const INITIATE_PARAMS: InitiateParams = {
  settlementId: 'st-1', ownerId: 'm1', currency: 'USD', amount: 10_500n, walletType: 'collection',
};
const RESOLVE_PARAMS: ResolveParams = {
  settlementId: 'st-1', ownerId: 'm1', currency: 'USD', walletType: 'collection',
};

const available = refKey(accountRef.user('m1', 'USD', 'collection', 'available'));
const heldOutflow = refKey(accountRef.user('m1', 'USD', 'collection', 'held-outflow'));
const externalPayout = refKey(accountRef.systemPayout('USD'));

interface FakePosting {
  reference: string;
  accountId: string;
  operationType: string;
  direction: Direction;
  amount: bigint;
}

/** In-memory posting log: transitions are applied in sequence and preconditions are
 * exercised by summing what earlier transitions wrote, as the real ledger does. */
class FakeLedger {
  private postings: FakePosting[] = [];

  readonly ctx = {
    session: undefined as never,
    readBalance: () => { throw new Error('not used by settlement transitions') },
    referenceNetAmount: async (reference: string, account: AccountRef, operationTypes?: string[]) => {
      const id = refKey(account);
      return this.postings
        .filter((p) => p.reference === reference && p.accountId === id)
        .filter((p) => !operationTypes || operationTypes.includes(p.operationType))
        .reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
    },
    referenceEntryIds: () => { throw new Error('not used by settlement transitions') },
  } satisfies PrePostContext;

  private record(reference: string, operationType: string, entries: EntryI[]): void {
    for (const entry of entries) {
      for (const posting of entry.postings) {
        this.postings.push({
          reference,
          accountId: refKey(posting.account),
          operationType,
          direction: posting.direction,
          amount: posting.amount,
        });
      }
    }
  }

  async applyInitiate(params: InitiateParams = INITIATE_PARAMS) {
    const plan = await planInitiate(this.ctx, params);
    this.record(params.settlementId, SettlementOperation.initiate, plan.entries);
    return plan;
  }

  async apply(status: SettlementResolution, params: ResolveParams = RESOLVE_PARAMS) {
    const transition = SETTLEMENT_TRANSITIONS[status];
    const plan = await transition.plan(this.ctx, params);
    this.record(params.settlementId, transition.operationType, plan.entries);
    return plan;
  }
}

async function codeOf(run: Promise<unknown>): Promise<ErrorCode> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).code;
  }
  throw new Error('expected the transition to be rejected');
}

const shape = (entries: EntryI[]) =>
  entries.flatMap((e) => e.postings.map((p) => [refKey(p.account), p.direction, p.amount]));

const net = (entries: EntryI[]) =>
  entries.map((e) => e.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n));

describe('settlement transitions', () => {
  let ledger: FakeLedger;

  beforeEach(() => {
    ledger = new FakeLedger();
  });

  describe('postings', () => {
    it('initiate moves available into held-outflow and guards available', async () => {
      const plan = await ledger.applyInitiate();

      expect(shape(plan.entries)).toEqual([
        [available, 'debit', 10_500n],
        [heldOutflow, 'credit', 10_500n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([available]);
      expect(plan.entries[0].metadata).toEqual({
        settlementId: 'st-1', ownerId: 'm1', currency: 'USD', amount: '10500', walletType: 'collection',
      });
    });

    it('success releases held-outflow to external:payout for the held amount', async () => {
      await ledger.applyInitiate();
      const plan = await ledger.apply('success');

      expect(shape(plan.entries)).toEqual([
        [heldOutflow, 'debit', 10_500n],
        [externalPayout, 'credit', 10_500n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([heldOutflow]);
    });

    it('failed returns held-outflow to available for the held amount', async () => {
      await ledger.applyInitiate();
      const plan = await ledger.apply('failed');

      expect(shape(plan.entries)).toEqual([
        [heldOutflow, 'debit', 10_500n],
        [available, 'credit', 10_500n],
      ]);
      expect(plan.guardNegative.map(refKey)).toEqual([heldOutflow]);
    });

    it('operates on the payout wallet when asked', async () => {
      const plan = await ledger.applyInitiate({ ...INITIATE_PARAMS, walletType: 'payout' });
      expect(shape(plan.entries)[0][0]).toBe(refKey(accountRef.user('m1', 'USD', 'payout', 'available')));

      const resolved = await ledger.apply('success', { ...RESOLVE_PARAMS, walletType: 'payout' });
      expect(shape(resolved.entries)[0][0]).toBe(refKey(accountRef.user('m1', 'USD', 'payout', 'held-outflow')));
    });

    it('every entry is balanced', async () => {
      expect(net((await ledger.applyInitiate()).entries)).toEqual([0n]);
      expect(net((await ledger.apply('success')).entries)).toEqual([0n]);
    });
  });

  describe('preconditions', () => {
    it('rejects a second initiate for the same settlement', async () => {
      await ledger.applyInitiate();
      expect(await codeOf(ledger.applyInitiate())).toBe(ErrorCode.SETTLEMENT_ALREADY_INITIATED);
    });

    it.each(['success', 'failed'] as const)('rejects %s before initiate', async (status) => {
      expect(await codeOf(ledger.apply(status))).toBe(ErrorCode.SETTLEMENT_NOT_INITIATED);
    });

    it.each([
      ['success', 'success'],
      ['success', 'failed'],
      ['failed', 'success'],
      ['failed', 'failed'],
    ] as const)('rejects %s followed by %s', async (first, second) => {
      await ledger.applyInitiate();
      await ledger.apply(first);
      expect(await codeOf(ledger.apply(second))).toBe(ErrorCode.SETTLEMENT_ALREADY_RESOLVED);
    });

    it('a resolve for a different wallet type finds nothing held', async () => {
      await ledger.applyInitiate();
      expect(await codeOf(ledger.apply('success', { ...RESOLVE_PARAMS, walletType: 'payout' })))
        .toBe(ErrorCode.SETTLEMENT_NOT_INITIATED);
    });

    it('does not allow re-initiating after the settlement failed', async () => {
      await ledger.applyInitiate();
      await ledger.apply('failed');
      expect(await codeOf(ledger.applyInitiate())).toBe(ErrorCode.SETTLEMENT_ALREADY_INITIATED);
    });
  });
});
