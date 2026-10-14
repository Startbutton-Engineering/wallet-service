import { Injectable } from "@nestjs/common";
import { ClientSession, Types } from "mongoose";
import { accountRef, AccountRef, System, UserAccountTpe, WalletType } from "../accounts/account";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { convertMinorUnits } from "../common/exchange-rate";
import { balanceToJson } from "../wallets/dto";
import { EntryI, OutboxEventType } from "./types";
import type { LedgerOperation, PostArgs, PostPostingContext, PrePostContext } from "./ledger.service";
import { LegacyWalletsService, majorToMinor } from "./legacy-wallets.service";

/**
 * Transactions created before an owner's balances moved to the ledger never ran on it, so their
 * later transitions (a payout succeeding, a collection settling) have nothing to resolve. Rather
 * than reject them, they are applied as legacy would have applied them, against the wallet's
 * `legacy-pending` account: back-end calls the normal endpoints and never needs to know.
 */

export const LEGACY_EFFECT_OPERATION = 'legacy.effect';

export type LegacyEffectField = 'availableBalance' | 'ledgerBalance' | 'both' | 'refundsOrChargeBackBalance' | 'rollingReserveOverdraftBalance';

export interface LegacyWallet { ownerId: string; walletType: WalletType; currency: string }

export interface LegacyEffect {
  direction: 'debit' | 'credit';
  updatedField: LegacyEffectField;
  amount: bigint;
  allowOverdraft?: boolean;
}

/**
 * The posting that moves the ledger as legacy would have: `from` is debited, `to` credited.
 * Legacy `ledgerBalance` = available + lien + held + legacy-pending, so a ledger-only change moves
 * `legacy-pending`, an available-only change moves between `available` and `legacy-pending`, and a
 * both-balances change moves between `available` and `external:legacy`.
 */
export function planLegacyEffect(wallet: LegacyWallet, effect: LegacyEffect): { from: AccountRef; to: AccountRef; guardNegative: AccountRef[] } {
  const { ownerId, walletType, currency } = wallet;
  const { direction, updatedField, allowOverdraft } = effect;
  const user = (accountType: UserAccountTpe) => accountRef.user(ownerId, currency, walletType, accountType);
  const external = accountRef.system(System.legacy, currency);
  // [the account a credit takes from, the account it lands in]
  const creditPairs: Record<LegacyEffectField, [AccountRef, AccountRef]> = {
    availableBalance: [user('legacy-pending'), user('available')],
    ledgerBalance: [external, user('legacy-pending')],
    both: [external, user('available')],
    refundsOrChargeBackBalance: [external, user('refund-chargeback')],
    rollingReserveOverdraftBalance: [external, user('reserve-overdraft')],
  };
  const [source, target] = creditPairs[updatedField];
  const [from, to] = direction === 'credit' ? [source, target] : [target, source];
  const debitsAvailable = direction === 'debit' && (updatedField === 'availableBalance' || updatedField === 'both');
  return { from, to, guardNegative: debitsAvailable && !allowOverdraft ? [user('available')] : [] };
}

export interface WalletEffects { wallet: LegacyWallet; effects: LegacyEffect[] }

interface LegacyRecord { createdAt: Date; fromAmount?: number; toAmount?: number }

interface RouteContext {
  payload: Record<string, any>;
  record: LegacyRecord;
  ctx: PrePostContext;
  scaleOf: (currency: string) => Promise<number>;
  notes: { repaid?: bigint };
}

interface LegacyRoute {
  source: 'transactions' | 'refunds';
  reference: (payload: Record<string, any>) => string;
  plan: (r: RouteContext) => Promise<WalletEffects[]>;
  response: (r: RouteContext, post: PostPostingContext) => Promise<unknown>;
}

const effect = (direction: LegacyEffect['direction'], updatedField: LegacyEffectField, amount: bigint, allowOverdraft?: boolean): LegacyEffect =>
  ({ direction, updatedField, amount, ...(allowOverdraft ? { allowOverdraft } : {}) });

export async function creditWithRepayment(ctx: PrePostContext, wallet: LegacyWallet, updatedField: LegacyEffectField, amount: bigint): Promise<{ effects: LegacyEffect[]; repaid: bigint }> {
  if (wallet.walletType !== 'collection') return { effects: [effect('credit', updatedField, amount)], repaid: 0n };
  const { refundChargeback } = await ctx.readBalance(wallet.ownerId, wallet.currency, wallet.walletType);
  const repaid = refundChargeback < 0n ? (-refundChargeback < amount ? -refundChargeback : amount) : 0n;
  return { effects: [effect('credit', 'refundsOrChargeBackBalance', repaid), effect('credit', updatedField, amount - repaid)], repaid };
}

const balance = async (post: PostPostingContext, wallet: LegacyWallet) =>
  balanceToJson(await post.accountBalance(wallet.ownerId, wallet.currency, wallet.walletType));

const single = (walletType: WalletType) => (p: Record<string, any>): LegacyWallet => ({ ownerId: p.ownerId, currency: p.currency, walletType });

const payout = (field: LegacyEffectField, direction: LegacyEffect['direction']): LegacyRoute => ({
  source: 'transactions',
  reference: (p) => p.payoutId,
  plan: async ({ payload }) => [{ wallet: single('payout')(payload), effects: [effect(direction, field, BigInt(payload.amount))] }],
  response: async ({ payload }, post) => ({
    operationId: post.operationId, entryId: post.entryIds[0], payoutId: payload.payoutId, status: payload.status,
    balance: await balance(post, single('payout')(payload)),
  }),
});

const collection = (field: LegacyEffectField): LegacyRoute => ({
  source: 'transactions',
  reference: (p) => p.collectionId,
  plan: async ({ payload, ctx, notes }) => {
    const credit = await creditWithRepayment(ctx, single('collection')(payload), field, BigInt(payload.amount));
    notes.repaid = credit.repaid;
    return [{ wallet: single('collection')(payload), effects: credit.effects }];
  },
  response: async ({ payload, notes }, post) => {
    const repaid = notes.repaid ?? 0n;
    return {
      operationId: post.operationId, entryId: post.entryIds[0], collectionId: payload.collectionId,
      settledToDebit: repaid.toString(), amountToCredit: (BigInt(payload.amount) - repaid).toString(),
      balance: await balance(post, single('collection')(payload)),
    };
  },
});

const settlementAmount = async ({ payload, record, scaleOf }: RouteContext): Promise<bigint> =>
  payload.amount !== undefined ? BigInt(payload.amount) : majorToMinor(record.fromAmount, await scaleOf(payload.currency));

const settlement = (field: LegacyEffectField, direction: LegacyEffect['direction']): LegacyRoute => ({
  source: 'transactions',
  reference: (p) => p.settlementId,
  plan: async (r) => [{ wallet: single(r.payload.walletType)(r.payload), effects: [effect(direction, field, await settlementAmount(r))] }],
  response: async (r, post) => ({
    operationId: post.operationId, entryId: post.entryIds[0], settlementId: r.payload.settlementId,
    status: r.payload.status ?? 'initiated', currency: r.payload.currency, amount: (await settlementAmount(r)).toString(),
    walletType: r.payload.walletType, balance: await balance(post, single(r.payload.walletType)(r.payload)),
  }),
});

const conversionWallets = (p: Record<string, any>) => ({
  from: { ownerId: p.ownerId, currency: p.fromCurrency, walletType: p.walletType } as LegacyWallet,
  to: { ownerId: p.ownerId, currency: p.toCurrency, walletType: p.walletType } as LegacyWallet,
});

const conversionAmounts = async ({ payload, record, scaleOf }: RouteContext): Promise<{ fromAmount: bigint; toAmount: bigint }> => {
  const fromScale = await scaleOf(payload.fromCurrency);
  const toScale = await scaleOf(payload.toCurrency);
  if (payload.fromAmount !== undefined) {
    const fromAmount = BigInt(payload.fromAmount);
    return { fromAmount, toAmount: convertMinorUnits(fromAmount, fromScale, toScale, payload.rate) };
  }
  return { fromAmount: majorToMinor(record.fromAmount, fromScale), toAmount: majorToMinor(record.toAmount, toScale) };
};

const conversion = (fromLeg: [LegacyEffect['direction'], LegacyEffectField], toLeg: [LegacyEffect['direction'], LegacyEffectField]): LegacyRoute => ({
  source: 'transactions',
  reference: (p) => p.conversionId,
  plan: async (r) => {
    const { from, to } = conversionWallets(r.payload);
    const { fromAmount, toAmount } = await conversionAmounts(r);
    return [
      { wallet: from, effects: [effect(fromLeg[0], fromLeg[1], fromAmount)] },
      { wallet: to, effects: [effect(toLeg[0], toLeg[1], toAmount)] },
    ];
  },
  response: async (r, post) => {
    const { from, to } = conversionWallets(r.payload);
    const { fromAmount, toAmount } = await conversionAmounts(r);
    return {
      operationId: post.operationId, entryIds: post.entryIds, conversionId: r.payload.conversionId,
      status: r.payload.status ?? 'initiated', fromCurrency: from.currency, toCurrency: to.currency,
      ...(r.payload.rate ? { rate: r.payload.rate } : {}),
      fromAmount: fromAmount.toString(), toAmount: toAmount.toString(), walletType: r.payload.walletType,
      fromBalance: await balance(post, from), toBalance: await balance(post, to),
    };
  },
});

const refundResponse = async ({ payload }: RouteContext, post: PostPostingContext) => ({
  operationId: post.operationId, entryId: post.entryIds[0], refundId: payload.refundId,
  ...(payload.transferReference ? { transferReference: payload.transferReference } : {}),
  status: payload.status, balance: await balance(post, single('collection')(payload)),
});

const refund = (plan: (r: RouteContext) => Promise<LegacyEffect[]>): LegacyRoute => ({
  source: 'refunds',
  reference: (p) => p.refundId,
  plan: async (r) => [{ wallet: single('collection')(r.payload), effects: await plan(r) }],
  response: refundResponse,
});

const refundFee = (field: LegacyEffectField, direction: LegacyEffect['direction']): LegacyRoute => ({
  source: 'transactions',
  reference: (p) => p.transferReference,
  plan: async ({ payload }) => [{ wallet: single('collection')(payload), effects: [effect(direction, field, BigInt(payload.amount))] }],
  response: refundResponse,
});

const refundPending = async ({ payload, ctx }: RouteContext): Promise<LegacyEffect[]> => {
  const amount = BigInt(payload.amount);
  const { available, lien } = await ctx.readBalance(payload.ownerId, payload.currency, 'collection');
  const legacyAvailable = available + lien;
  if (!payload.allowOverdraft || legacyAvailable >= amount) return [effect('debit', 'both', amount)];
  const deficit = amount - (legacyAvailable > 0n ? legacyAvailable : 0n);
  return [effect('debit', 'both', amount - deficit, true), effect('debit', 'refundsOrChargeBackBalance', deficit)];
};

const ROUTES: Record<string, LegacyRoute> = {
  'payout.initiate': payout('availableBalance', 'debit'),
  'payout.success': payout('ledgerBalance', 'debit'),
  'payout.failed': payout('availableBalance', 'credit'),
  'payout.reverse': payout('both', 'credit'),
  'payout.reverse-failed': payout('both', 'debit'),
  'collection.receive': collection('ledgerBalance'),
  'collection.settle': collection('availableBalance'),
  'settlement.initiate': settlement('availableBalance', 'debit'),
  'settlement.success': settlement('ledgerBalance', 'debit'),
  'settlement.failed': settlement('availableBalance', 'credit'),
  'conversion.initiate': conversion(['debit', 'availableBalance'], ['credit', 'ledgerBalance']),
  'conversion.approve': conversion(['debit', 'ledgerBalance'], ['credit', 'availableBalance']),
  'conversion.reject': conversion(['credit', 'availableBalance'], ['debit', 'ledgerBalance']),
  'topup.credit': {
    source: 'transactions',
    reference: (p) => p.topupId,
    plan: async ({ payload }) => [{ wallet: single('payout')(payload), effects: [effect('credit', 'both', BigInt(payload.amount))] }],
    response: async ({ payload }, post) => ({
      operationId: post.operationId, entryId: post.entryIds[0], topupId: payload.topupId, balance: await balance(post, single('payout')(payload)),
    }),
  },
  'refund.pending': refund(refundPending),
  // The refund already left the wallet at pending; success moves nothing of the owner's.
  'refund.success': refund(async () => []),
  'refund.failed': refund(async ({ payload, ctx }) =>
    (await creditWithRepayment(ctx, single('collection')(payload), 'both', BigInt(payload.amount))).effects),
  'refund.fee.initiate': refundFee('availableBalance', 'debit'),
  'refund.fee.success': refundFee('ledgerBalance', 'debit'),
  'refund.fee.reverse': refundFee('availableBalance', 'credit'),
  'refund.fee.reverse-failed': refundFee('both', 'debit'),
};

@Injectable()
export class LegacyRouteService {
  constructor(
    private readonly legacyWallets: LegacyWalletsService,
    private readonly currencies: CurrencyRegistryService,
  ) {}

  async plan<T>(args: PostArgs<T>, ctx: PrePostContext): Promise<LedgerOperation<T> | null> {
    const route = ROUTES[args.operationType];
    if (!route) return null;
    const payload = args.requestPayload as Record<string, any>;
    const reference = route.reference(payload);
    const records = await this.legacyRecords(route.source, payload.ownerId, [reference], ctx.session);
    const record = records.get(reference);
    if (!record) return null;

    const r: RouteContext = { payload, record, ctx, notes: {}, scaleOf: async (currency) => (await this.currencies.require(currency)).scale };
    const groups = await route.plan(r);
    return {
      ...this.operation(args.operationType, reference, groups),
      buildResponse: (post) => route.response(r, post) as Promise<T>,
      buildEvent: (post) => ({
        type: OutboxEventType.LEGACY_EFFECT_APPLIED,
        schemaVersion: 1,
        payload: { operationId: post.operationId, nativeOperation: args.operationType, reference, ownerId: payload.ownerId, ...effectsJson(groups) },
      }),
    };
  }

  async legacyRecords(source: LegacyRoute['source'], ownerId: string, references: string[], session?: ClientSession): Promise<Map<string, LegacyRecord>> {
    const cutoverAt = await this.legacyWallets.cutoverAt(ownerId, session);
    if (!cutoverAt || !references.length) return new Map();
    const filter = source === 'refunds'
      ? { merchant: new Types.ObjectId(ownerId), reference: { $in: references } }
      : { transactionReference: { $in: references } };
    const docs = await this.legacyWallets.collection(source)
      .find(filter, { session, projection: { transactionReference: 1, reference: 1, createdAt: 1, fromAmount: 1, toAmount: 1 } })
      .toArray();
    return new Map(docs
      .filter((doc) => doc.createdAt && new Date(doc.createdAt) < cutoverAt)
      .map((doc) => [String(source === 'refunds' ? doc.reference : doc.transactionReference), doc as unknown as LegacyRecord]));
  }

  operation(nativeOperation: string, reference: string, groups: WalletEffects[]): Pick<LedgerOperation<unknown>, 'entries' | 'guardNegative'> {
    const entries: EntryI[] = [];
    const guardNegative: AccountRef[] = [];
    for (const { wallet, effects } of groups) {
      const postings = effects.filter((e) => e.amount > 0n).flatMap((e) => {
        const { from, to, guardNegative: guards } = planLegacyEffect(wallet, e);
        guardNegative.push(...guards);
        return [
          { account: from, direction: 'debit' as const, amount: e.amount },
          { account: to, direction: 'credit' as const, amount: e.amount },
        ];
      });
      if (postings.length) {
        entries.push({ currency: wallet.currency, reference, operationType: LEGACY_EFFECT_OPERATION, metadata: { nativeOperation }, postings });
      }
    }
    return { entries, guardNegative };
  }
}

const effectsJson = (groups: WalletEffects[]) => ({
  wallets: groups.map(({ wallet, effects }) => ({
    ...wallet,
    effects: effects.map((e) => ({ ...e, amount: e.amount.toString() })),
  })),
});
