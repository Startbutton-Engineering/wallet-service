import { AccountRef, accountRef, refKey } from "../../../src/accounts/account";
import { AppError, ErrorCode } from "../../../src/common/errors";
import { PrePostContext } from "../../../src/ledger/ledger.service";
import { Direction, EntryI, signedDelta } from "../../../src/ledger/types";
import {
  CONVERSION_TRANSITIONS,
  ConversionOperation,
  ConversionResolution,
  InitiateParams,
  ResolveParams,
  planInitiate,
} from "../../../src/conversions/conversion-transitions";
import { WalletType } from "../../../src/accounts/account";
import { walletBalance } from "../../mocks";

const INITIATE_PARAMS: InitiateParams = {
  conversionId: 'cv-1',
  ownerId: 'm1',
  fromCurrency: 'NGN',
  toCurrency: 'USD',
  fromAmount: 150_000n,
  rate: '1500',
  fromScale: 2,
  toScale: 2,
  walletType: 'collection',
};
const RESOLVE_PARAMS: ResolveParams = {
  conversionId: 'cv-1', ownerId: 'm1', fromCurrency: 'NGN', toCurrency: 'USD', walletType: 'collection',
};

interface FakePosting {
  reference: string;
  accountId: string;
  operationType: string;
  direction: Direction;
  amount: bigint;
}

function accountId(ref: AccountRef): string {
  return refKey(ref);
}

/** An in-memory stand-in for the posting log the real PrePostContext reads. Transitions are
 * applied in sequence against it, so preconditions are exercised the same way they are in
 * Mongo — by summing what earlier transitions wrote. */
class FakeLedger {
  private postings: FakePosting[] = [];
  /** The owner's refund-chargeback balance, as approve reads it for the toCurrency wallet. */
  refundChargeback = 0n;

  readonly ctx = {
    session: undefined as never,
    readBalance: async (ownerId: string, currency: string, walletType: WalletType) =>
      walletBalance({ ownerId, currency, walletType, refundChargeback: this.refundChargeback }),
    referenceNetAmount: async (reference: string, account: AccountRef, operationTypes?: string[]) => {
      const id = accountId(account);
      return this.postings
        .filter((p) => p.reference === reference && p.accountId === id)
        .filter((p) => !operationTypes || operationTypes.includes(p.operationType))
        .reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
    },
    referenceEntryIds: () => { throw new Error('not used by conversion transitions') },
  } satisfies PrePostContext;

  private record(reference: string, operationType: string, entries: EntryI[]): void {
    for (const entry of entries) {
      for (const posting of entry.postings) {
        this.postings.push({
          reference,
          accountId: accountId(posting.account),
          operationType,
          direction: posting.direction,
          amount: posting.amount,
        });
      }
    }
  }

  async applyInitiate(params: InitiateParams = INITIATE_PARAMS) {
    const { plan, toAmount } = await planInitiate(this.ctx, params);
    this.record(params.conversionId, ConversionOperation.initiate, plan.entries);
    return { plan, toAmount };
  }

  planInitiateOnly(params: InitiateParams = INITIATE_PARAMS) {
    return planInitiate(this.ctx, params);
  }

  async apply(status: ConversionResolution, params: ResolveParams = RESOLVE_PARAMS) {
    const transition = CONVERSION_TRANSITIONS[status];
    const plan = await transition.plan(this.ctx, params);
    this.record(params.conversionId, transition.operationType, plan.entries);
    return plan;
  }

  planOnly(status: ConversionResolution, params: ResolveParams = RESOLVE_PARAMS) {
    return CONVERSION_TRANSITIONS[status].plan(this.ctx, params);
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

describe('conversion transitions', () => {
  let ledger: FakeLedger;

  beforeEach(() => {
    ledger = new FakeLedger();
  });

  describe('postings', () => {
    it('initiate moves fromCurrency available into held-inflow and fronts toCurrency held-inflow from the fx desk', async () => {
      const { plan, toAmount } = await ledger.planInitiateOnly();
      expect(toAmount).toBe(100n); // ₦1500.00 at rate 1500 -> $1.00

      expect(plan.entries).toHaveLength(2);
      expect(plan.entries[0].currency).toBe('NGN');
      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'NGN', 'available')), 'debit', 150_000n],
        [refKey(accountRef.collectionWallet('m1', 'NGN', 'held-inflow')), 'credit', 150_000n],
      ]);
      expect(plan.entries[1].currency).toBe('USD');
      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.system('fx:USD', 'USD')), 'debit', 100n],
        [refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')), 'credit', 100n],
      ]);
      expect(plan.guardNegative.map(accountId)).toEqual([
        refKey(accountRef.collectionWallet('m1', 'NGN', 'available')),
      ]);
    });

    it('carries the currency pair, rate and amounts as identical metadata on both entries', async () => {
      const { plan } = await ledger.planInitiateOnly();
      const expectedMetadata = {
        conversionId: 'cv-1', ownerId: 'm1', fromCurrency: 'NGN', toCurrency: 'USD',
        rate: '1500', fromAmount: '150000', toAmount: '100', walletType: 'collection',
      };
      expect(plan.entries[0].metadata).toEqual(expectedMetadata);
      expect(plan.entries[1].metadata).toEqual(expectedMetadata);
    });

    it('generalizes to any registered currency pair, not just NGN/USD', async () => {
      const params: InitiateParams = {
        conversionId: 'cv-9', ownerId: 'm1', fromCurrency: 'USD', toCurrency: 'GBP',
        fromAmount: 10_000n, rate: '1.25', fromScale: 2, toScale: 2, walletType: 'collection',
      };
      const { plan, toAmount } = await ledger.planInitiateOnly(params);

      expect(toAmount).toBe(8_000n); // $100.00 at 1.25 USD/GBP -> £80.00
      expect(plan.entries[0].currency).toBe('USD');
      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'USD', 'available')), 'debit'],
        [refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')), 'credit'],
      ]);
      expect(plan.entries[1].currency).toBe('GBP');
      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction])).toEqual([
        [refKey(accountRef.system('fx:GBP', 'GBP')), 'debit'],
        [refKey(accountRef.collectionWallet('m1', 'GBP', 'held-inflow')), 'credit'],
      ]);
    });

    it('approve settles fromCurrency to the house and releases toCurrency to available', async () => {
      await ledger.applyInitiate();
      const plan = await ledger.planOnly('approved');

      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'NGN', 'held-inflow')), 'debit', 150_000n],
        [refKey(accountRef.system('fx:NGN', 'NGN')), 'credit', 150_000n],
      ]);
      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')), 'debit', 100n],
        [refKey(accountRef.collectionWallet('m1', 'USD', 'available')), 'credit', 100n],
      ]);
      expect(plan.guardNegative.map(accountId)).toEqual([
        refKey(accountRef.collectionWallet('m1', 'NGN', 'held-inflow')),
        refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')),
      ]);
    });

    it('approve into a collection wallet repays refund-chargeback debt before crediting available', async () => {
      await ledger.applyInitiate();
      ledger.refundChargeback = -30n;
      const plan = await ledger.planOnly('approved');

      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')), 'debit', 100n],
        [refKey(accountRef.collectionWallet('m1', 'USD', 'refund-chargeback')), 'credit', 30n],
        [refKey(accountRef.collectionWallet('m1', 'USD', 'available')), 'credit', 70n],
      ]);
      expect(plan.settledToDebit).toBe(30n);
    });

    it('approve into a payout wallet ignores refund-chargeback debt', async () => {
      const initiateParams: InitiateParams = { ...INITIATE_PARAMS, conversionId: 'cv-payout-debt', walletType: 'payout' };
      const resolveParams: ResolveParams = { ...RESOLVE_PARAMS, conversionId: 'cv-payout-debt', walletType: 'payout' };
      await ledger.applyInitiate(initiateParams);
      ledger.refundChargeback = -30n;
      const plan = await ledger.planOnly('approved', resolveParams);

      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.payoutWallet('m1', 'USD', 'held-inflow')), 'debit', 100n],
        [refKey(accountRef.payoutWallet('m1', 'USD', 'available')), 'credit', 100n],
      ]);
      expect(plan.settledToDebit).toBe(0n);
    });

    it('reject reverses initiate exactly: fromCurrency back to available, toCurrency back to the fx desk', async () => {
      await ledger.applyInitiate();
      const plan = await ledger.planOnly('rejected');

      expect(plan.entries[0].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'NGN', 'held-inflow')), 'debit', 150_000n],
        [refKey(accountRef.collectionWallet('m1', 'NGN', 'available')), 'credit', 150_000n],
      ]);
      expect(plan.entries[1].postings.map((p) => [accountId(p.account), p.direction, p.amount])).toEqual([
        [refKey(accountRef.collectionWallet('m1', 'USD', 'held-inflow')), 'debit', 100n],
        [refKey(accountRef.system('fx:USD', 'USD')), 'credit', 100n],
      ]);
    });

    it.each(['approved', 'rejected'] as ConversionResolution[])(
      'every entry along initiate -> %s is balanced',
      async (status) => {
        const { plan: initiatePlan } = await ledger.planInitiateOnly();
        for (const entry of initiatePlan.entries) {
          const net = entry.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
          expect(net).toBe(0n);
          expect(entry.postings.every((posting) => posting.amount > 0n)).toBe(true);
        }
        await ledger.applyInitiate();

        const plan = await ledger.planOnly(status);
        for (const entry of plan.entries) {
          const net = entry.postings.reduce((sum, p) => sum + signedDelta(p.direction, p.amount), 0n);
          expect(net).toBe(0n);
          expect(entry.postings.every((posting) => posting.amount > 0n)).toBe(true);
        }
      },
    );
  });

  describe('wallet type', () => {
    it('operates on the payout wallet for both legs when walletType is payout', async () => {
      const params: InitiateParams = { ...INITIATE_PARAMS, conversionId: 'cv-payout', walletType: 'payout' };
      const { plan } = await ledger.planInitiateOnly(params);

      expect(plan.entries[0].postings.map((p) => accountId(p.account))).toEqual([
        refKey(accountRef.payoutWallet('m1', 'NGN', 'available')),
        refKey(accountRef.payoutWallet('m1', 'NGN', 'held-inflow')),
      ]);
      expect(plan.entries[1].postings.map((p) => accountId(p.account))).toEqual([
        refKey(accountRef.system('fx:USD', 'USD')),
        refKey(accountRef.payoutWallet('m1', 'USD', 'held-inflow')),
      ]);
    });

    it('round-trips initiate -> approve on the payout wallet without touching the collection wallet', async () => {
      const initiateParams: InitiateParams = { ...INITIATE_PARAMS, conversionId: 'cv-payout', walletType: 'payout' };
      await ledger.applyInitiate(initiateParams);
      const resolveParams: ResolveParams = { ...RESOLVE_PARAMS, conversionId: 'cv-payout', walletType: 'payout' };
      const plan = await ledger.planOnly('approved', resolveParams);

      expect(plan.entries[0].postings.map((p) => accountId(p.account))).toEqual([
        refKey(accountRef.payoutWallet('m1', 'NGN', 'held-inflow')),
        refKey(accountRef.system('fx:NGN', 'NGN')),
      ]);
      expect(plan.entries[1].postings.map((p) => accountId(p.account))).toEqual([
        refKey(accountRef.payoutWallet('m1', 'USD', 'held-inflow')),
        refKey(accountRef.payoutWallet('m1', 'USD', 'available')),
      ]);
    });

    it('keeps collection and payout conversions of the same owner/currency independent', async () => {
      await ledger.applyInitiate({ ...INITIATE_PARAMS, conversionId: 'cv-collection' });
      const payoutParams: InitiateParams = { ...INITIATE_PARAMS, conversionId: 'cv-collection', walletType: 'payout' };
      await expect(ledger.planInitiateOnly(payoutParams)).resolves.toBeDefined();
    });
  });

  describe('preconditions', () => {
    it('rejects initiating the same conversion twice', async () => {
      await ledger.applyInitiate();
      expect(await codeOf(ledger.planInitiateOnly())).toBe(ErrorCode.CONVERSION_ALREADY_INITIATED);
    });

    it('rejects converting a currency into itself', async () => {
      const same = { ...INITIATE_PARAMS, toCurrency: 'NGN' };
      expect(await codeOf(ledger.planInitiateOnly(same))).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects an amount and rate that round the toCurrency leg to zero', async () => {
      const tiny = { ...INITIATE_PARAMS, fromAmount: 1n, rate: '300' };
      expect(await codeOf(ledger.planInitiateOnly(tiny))).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it.each(['approved', 'rejected'] as ConversionResolution[])(
      'rejects %s for a conversion that was never initiated',
      async (status) => {
        expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.CONVERSION_NOT_INITIATED);
      },
    );

    it.each(['approved', 'rejected'] as ConversionResolution[])(
      'rejects %s once the conversion is already resolved',
      async (status) => {
        await ledger.applyInitiate();
        await ledger.apply('approved');
        expect(await codeOf(ledger.planOnly(status))).toBe(ErrorCode.CONVERSION_ALREADY_RESOLVED);
      },
    );

    it('rejects approving after a rejection', async () => {
      await ledger.applyInitiate();
      await ledger.apply('rejected');
      expect(await codeOf(ledger.planOnly('approved'))).toBe(ErrorCode.CONVERSION_ALREADY_RESOLVED);
    });

    it('keeps conversions independent: another conversionId has its own state', async () => {
      await ledger.applyInitiate();
      const other = { ...INITIATE_PARAMS, conversionId: 'cv-2' };
      await expect(ledger.planInitiateOnly(other)).resolves.toBeDefined();
      expect(
        await codeOf(ledger.planOnly('approved', { ...RESOLVE_PARAMS, conversionId: 'cv-2' })),
      ).toBe(ErrorCode.CONVERSION_NOT_INITIATED);
    });
  });
});
