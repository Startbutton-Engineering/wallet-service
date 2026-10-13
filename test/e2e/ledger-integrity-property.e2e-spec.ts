import { randomUUID } from "crypto";
import request from 'supertest';
import fc from 'fast-check';
import { createTestApp, TEST_API_KEY, TestApp } from "../utils/app";
import { RecordingNotifier } from "../utils/recording-notifier";
import { LEDGER_ALERT_NOTIFIER } from "../../src/reconciliation/alerts/ledger-alert";

// Every operation is a real HTTP call and a real replica-set transaction, so the default budget is
// small. Raise it for a deeper search: FC_NUM_RUNS=500 npx jest test/e2e/ledger-integrity-property
const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 25;

/** One HTTP call into the ledger: a path and its body. */
interface Op {
  path: string;
  body: Record<string, unknown>;
}

/**
 * One flow's fixed parameters. Operations pick a slot and an action, so a settle, payout or
 * conversion on a slot matches what that slot collected and the success paths really run —
 * independently random fields would almost always be rejected and prove nothing.
 */
interface Slot {
  ref: string;
  ownerId: string;
  currency: 'NGN' | 'USD';
  /** Collected and settled in full; every other flow on the slot moves half of it. */
  amount: bigint;
}

const slot = (ref: string): fc.Arbitrary<Slot> =>
  fc.record({
    ref: fc.constant(ref),
    // Two owners across three slots, so flows also collide on the same wallet.
    ownerId: fc.constantFrom('owner-a', 'owner-b'),
    currency: fc.constantFrom('NGN' as const, 'USD' as const),
    amount: fc.bigInt({ min: 10_000n, max: 500_000n }),
  });

const ACTIONS = [
  'collect', 'settle',
  'to-payout', 'to-collection',
  'payout:initiated', 'payout:success', 'payout:failed', 'payout:reversed', 'payout:reverse-failed',
  'conversion:initiate', 'conversion:approve', 'conversion:reject',
  'settlement:initiate', 'settlement:success', 'settlement:fail',
  'refund:pending', 'refund:success', 'refund:failed',
  'refund-fee:initiated', 'refund-fee:success', 'refund-fee:reversed', 'refund-fee:reverse-failed',
] as const;
type Action = (typeof ACTIONS)[number];

const either = <T>(...xs: T[]) => fc.constantFrom(...xs);

/** What a slot does after it is funded: one realistic lifecycle, in order. */
const tail: fc.Arbitrary<Action[]> = fc.oneof(
  fc
    .tuple(either<Action>('payout:success', 'payout:failed'), fc.boolean(), fc.boolean())
    .map(([outcome, reverse, reverseFails]): Action[] => [
      'to-payout', 'payout:initiated', outcome,
      ...(outcome === 'payout:success' && reverse ? ['payout:reversed' as const] : []),
      ...(outcome === 'payout:success' && reverse && reverseFails ? ['payout:reverse-failed' as const] : []),
    ]),
  either<Action>('conversion:approve', 'conversion:reject').map((o): Action[] => ['conversion:initiate', o]),
  either<Action>('settlement:success', 'settlement:fail').map((o): Action[] => ['settlement:initiate', o]),
  either<Action>('refund:success', 'refund:failed').map((o): Action[] => ['refund:pending', o]),
  either<Action>('refund-fee:success', 'refund-fee:reversed').map((o): Action[] => [
    'refund:pending', 'refund-fee:initiated', o, 'refund:success',
  ]),
  // Anything at all, in any order: exercises the rejection paths too.
  fc.array(fc.constantFrom<Action>(...ACTIONS), { minLength: 1, maxLength: 3 }),
);

// Usually settled: an unsettled collection leaves the money held, so the rest of the lifecycle
// would only exercise INSUFFICIENT_FUNDS.
const lifecycle: fc.Arbitrary<Action[]> = fc
  .tuple(fc.integer({ min: 0, max: 9 }), tail)
  .map(([roll, rest]) => ['collect', ...(roll > 0 ? ['settle' as const] : []), ...rest]);

const scenario = fc.record({
  slots: fc.tuple(slot('ref-1'), slot('ref-2'), slot('ref-3')),
  lifecycles: fc.tuple(lifecycle, lifecycle, lifecycle),
  /** Which slot moves next: interleaves the three lifecycles. */
  order: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 24 }),
  allowOverdraft: fc.boolean(),
});

function toOp(s: Slot, action: Action, allowOverdraft: boolean): Op {
  const { ref, ownerId, currency } = s;
  const full = s.amount.toString();
  const half = (s.amount / 2n).toString();
  const [name, status] = action.split(':');
  const other = currency === 'NGN' ? 'USD' : 'NGN';
  // NGN→USD divides by 1500, USD→NGN multiplies by 1500: never rounds to zero for these amounts.
  const rate = currency === 'NGN' ? '1500' : '0.000666666666666667';
  switch (name) {
    case 'collect':
      return { path: '/collections/collect', body: { collectionId: ref, ownerId, currency, amount: full } };
    case 'settle':
      return { path: '/collections/settle', body: { collectionId: ref, ownerId, currency, amount: full } };
    case 'to-payout':
    case 'to-collection':
      return {
        path: '/wallets/transfer',
        body: {
          transferId: randomUUID(), ownerId, currency, amount: half,
          from: name === 'to-payout' ? 'collection' : 'payout', to: name === 'to-payout' ? 'payout' : 'collection',
        },
      };
    case 'payout':
      return { path: '/payouts/status', body: { payoutId: ref, ownerId, currency, amount: half, status } };
    case 'conversion':
      return status === 'initiate'
        ? { path: '/conversions/initiate', body: { conversionId: ref, ownerId, fromCurrency: currency, toCurrency: other, fromAmount: half, rate } }
        : { path: `/conversions/${status}`, body: { conversionId: ref, ownerId, fromCurrency: currency, toCurrency: other } };
    case 'settlement':
      return status === 'initiate'
        ? { path: '/settlements/initiate', body: { settlementId: ref, ownerId, currency, amount: half } }
        : { path: `/settlements/${status}`, body: { settlementId: ref, ownerId, currency } };
    case 'refund':
      return { path: '/refunds/status', body: { refundId: ref, ownerId, currency, amount: half, status, allowOverdraft } };
    default:
      return {
        path: '/refunds/fee/status',
        body: { refundId: ref, transferReference: `${ref}-transfer`, ownerId, currency, amount: (s.amount / 10n).toString(), status },
      };
  }
}

describe('Ledger integrity (property)', () => {
  let ctx: TestApp;
  const notifier = new RecordingNotifier();

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: LEDGER_ALERT_NOTIFIER, useValue: notifier }]);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('keeps the trial balance at zero and reconciliation clean after any sequence of operations', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ slots, lifecycles, order, allowOverdraft }) => {
        const next = [0, 0, 0];
        const ops: Op[] = [];
        for (const i of order) {
          const action = lifecycles[i][next[i]++];
          if (action) ops.push(toOp(slots[i], action, allowOverdraft));
        }
        // A fresh tenant per case keeps each sequence's ledger to itself.
        const tenantId = `prop-${randomUUID()}`;
        const server = ctx.app.getHttpServer();

        for (const { path, body } of ops) {
          const res = await request(server)
            .post(path)
            .set('x-api-key', TEST_API_KEY)
            .set('x-tenant-id', tenantId)
            .set('idempotency-key', randomUUID())
            .send(body);
          // Rejections (insufficient funds, already resolved, ...) are legitimate; a crash is not.
          if (res.status >= 500) throw new Error(`${path} crashed with ${res.status}: ${JSON.stringify(res.body)}`);
          if (process.env.FC_TRACE) console.log(`TRACE ${path} ${res.status} ${res.body?.code ?? res.body?.error?.code ?? JSON.stringify(res.body).slice(0, 120)}`);
        }

        const trialBalance = await request(server)
          .get('/reports/trial-balance')
          .set('x-api-key', TEST_API_KEY)
          .set('x-tenant-id', tenantId);
        expect(trialBalance.body.data.balanced).toBe(true);
        for (const c of trialBalance.body.data.currencies) expect(c.net).toBe('0');

        const run = await request(server)
          .post('/reconciliation/runs')
          .set('x-api-key', TEST_API_KEY)
          .set('x-tenant-id', tenantId);
        expect(run.body.data).toMatchObject({ status: 'ok', mismatchCount: 0, findings: [] });
        expect(notifier.sent).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
