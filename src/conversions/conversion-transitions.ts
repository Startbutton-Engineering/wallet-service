import { accountRef, AccountRef, System, WalletType } from "../accounts/account";
import { AppError } from "../common/errors";
import { convertMinorUnits } from "../common/exchange-rate";
import { PrePostContext } from "../ledger/ledger.service";
import { EntryI, OutboxEventType } from "../ledger/types";

export const ConversionOperation = {
  initiate: 'conversion.initiate',
  approve: 'conversion.approve',
  reject: 'conversion.reject',
} as const;

export const CONVERSION_RESOLUTIONS = ['approved', 'rejected'] as const;
export type ConversionResolution = (typeof CONVERSION_RESOLUTIONS)[number];

export interface InitiateParams {
  conversionId: string;
  ownerId: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: bigint;
  rate: string;
  fromScale: number;
  toScale: number;
  walletType: WalletType;
}

export interface ResolveParams {
  conversionId: string;
  ownerId: string;
  fromCurrency: string;
  toCurrency: string;
  walletType: WalletType;
}

export interface ConversionPlan {
  entries: EntryI[];
  guardNegative: AccountRef[];
}

const heldInflow = (ownerId: string, currency: string, walletType: WalletType): AccountRef =>
  accountRef.user(ownerId, currency, walletType, 'held-inflow');

const available = (ownerId: string, currency: string, walletType: WalletType): AccountRef =>
  accountRef.user(ownerId, currency, walletType, 'available');

const fx = (currency: string): AccountRef => accountRef.system(System.fx(currency), currency);

async function initiatedAmounts(
  ctx: PrePostContext,
  conversionId: string,
  ownerId: string,
  fromCurrency: string,
  toCurrency: string,
  walletType: WalletType,
): Promise<{ from: bigint; to: bigint }> {
  const from = await ctx.referenceNetAmount(conversionId, heldInflow(ownerId, fromCurrency, walletType), [ConversionOperation.initiate]);
  const to = await ctx.referenceNetAmount(conversionId, heldInflow(ownerId, toCurrency, walletType), [ConversionOperation.initiate]);
  return { from, to };
}

async function requirePending(
  ctx: PrePostContext,
  conversionId: string,
  ownerId: string,
  fromCurrency: string,
  toCurrency: string,
  walletType: WalletType,
): Promise<{ fromAmount: bigint; toAmount: bigint }> {
  const { from, to } = await initiatedAmounts(ctx, conversionId, ownerId, fromCurrency, toCurrency, walletType);
  if (from === 0n) throw AppError.conversionNotInitiated(conversionId);

  const outstanding = await ctx.referenceNetAmount(conversionId, heldInflow(ownerId, fromCurrency, walletType));
  if (outstanding === 0n) {
    throw AppError.conversionAlreadyResolved({ conversionId, fromAmount: from.toString() });
  }
  return { fromAmount: from, toAmount: to };
}

export async function planInitiate(
  ctx: PrePostContext,
  p: InitiateParams,
): Promise<{ plan: ConversionPlan; toAmount: bigint }> {
  if (p.fromCurrency === p.toCurrency) {
    throw AppError.validation('fromCurrency and toCurrency must be different', {
      conversionId: p.conversionId, currency: p.fromCurrency,
    });
  }

  const already = await ctx.referenceNetAmount(
    p.conversionId, heldInflow(p.ownerId, p.fromCurrency, p.walletType), [ConversionOperation.initiate],
  );
  if (already !== 0n) throw AppError.conversionAlreadyInitiated(p.conversionId);
  const toAmount = convertMinorUnits(p.fromAmount, p.fromScale, p.toScale, p.rate);
  if (toAmount === 0n) {
    throw AppError.validation(
      'Converted amount rounds to zero for this amount and rate',
      { conversionId: p.conversionId, fromAmount: p.fromAmount.toString(), rate: p.rate },
    );
  }

  const metadata = {
    conversionId: p.conversionId,
    ownerId: p.ownerId,
    fromCurrency: p.fromCurrency,
    toCurrency: p.toCurrency,
    rate: p.rate,
    fromAmount: p.fromAmount.toString(),
    toAmount: toAmount.toString(),
    walletType: p.walletType,
  };

  return {
    toAmount,
    plan: {
      entries: [
        {
          currency: p.fromCurrency,
          metadata,
          postings: [
            { account: available(p.ownerId, p.fromCurrency, p.walletType), direction: 'debit', amount: p.fromAmount },
            { account: heldInflow(p.ownerId, p.fromCurrency, p.walletType), direction: 'credit', amount: p.fromAmount },
          ],
        },
        {
          currency: p.toCurrency,
          metadata,
          postings: [
            { account: fx(p.toCurrency), direction: 'debit', amount: toAmount },
            { account: heldInflow(p.ownerId, p.toCurrency, p.walletType), direction: 'credit', amount: toAmount },
          ],
        },
      ],
      guardNegative: [available(p.ownerId, p.fromCurrency, p.walletType)],
    },
  };
}

async function planApprove(ctx: PrePostContext, p: ResolveParams): Promise<ConversionPlan> {
  const { fromAmount, toAmount } = await requirePending(ctx, p.conversionId, p.ownerId, p.fromCurrency, p.toCurrency, p.walletType);
  return {
    entries: [
      {
        currency: p.fromCurrency,
        postings: [
          { account: heldInflow(p.ownerId, p.fromCurrency, p.walletType), direction: 'debit', amount: fromAmount },
          { account: fx(p.fromCurrency), direction: 'credit', amount: fromAmount },
        ],
      },
      {
        currency: p.toCurrency,
        postings: [
          { account: heldInflow(p.ownerId, p.toCurrency, p.walletType), direction: 'debit', amount: toAmount },
          { account: available(p.ownerId, p.toCurrency, p.walletType), direction: 'credit', amount: toAmount },
        ],
      },
    ],
    guardNegative: [heldInflow(p.ownerId, p.fromCurrency, p.walletType), heldInflow(p.ownerId, p.toCurrency, p.walletType)],
  };
}

async function planReject(ctx: PrePostContext, p: ResolveParams): Promise<ConversionPlan> {
  const { fromAmount, toAmount } = await requirePending(ctx, p.conversionId, p.ownerId, p.fromCurrency, p.toCurrency, p.walletType);
  return {
    entries: [
      {
        currency: p.fromCurrency,
        postings: [
          { account: heldInflow(p.ownerId, p.fromCurrency, p.walletType), direction: 'debit', amount: fromAmount },
          { account: available(p.ownerId, p.fromCurrency, p.walletType), direction: 'credit', amount: fromAmount },
        ],
      },
      {
        currency: p.toCurrency,
        postings: [
          { account: heldInflow(p.ownerId, p.toCurrency, p.walletType), direction: 'debit', amount: toAmount },
          { account: fx(p.toCurrency), direction: 'credit', amount: toAmount },
        ],
      },
    ],
    guardNegative: [heldInflow(p.ownerId, p.fromCurrency, p.walletType), heldInflow(p.ownerId, p.toCurrency, p.walletType)],
  };
}

export interface ResolutionTransition {
  operationType: string;
  eventType: OutboxEventType;
  plan: (ctx: PrePostContext, p: ResolveParams) => Promise<ConversionPlan>;
}

export const CONVERSION_TRANSITIONS: Record<ConversionResolution, ResolutionTransition> = {
  approved: {
    operationType: ConversionOperation.approve,
    eventType: OutboxEventType.CONVERSION_APPROVED,
    plan: planApprove,
  },
  rejected: {
    operationType: ConversionOperation.reject,
    eventType: OutboxEventType.CONVERSION_REJECTED,
    plan: planReject,
  },
};
