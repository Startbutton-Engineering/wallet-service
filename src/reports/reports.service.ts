import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Account } from "../accounts/account.schema";
import { AccountDoc, AccountKind, System } from "../accounts/account";
import { fromDecimal128 } from "../common/money";

export interface SystemAccountLine {
  name: string;
  balance: string;
}

export interface UserAccountLine {
  walletType: string;
  accountType: string;
  accountCount: number;
  balance: string;
}

export interface CurrencyTrialBalance {
  currency: string;
  /** Sum of every negative account balance, as a positive amount. */
  totalDebits: string;
  /** Sum of every positive account balance. */
  totalCredits: string;
  net: string;
  balanced: boolean;
  systemAccounts: SystemAccountLine[];
  /** Aggregated by wallet and account type: one row per type, never one per wallet. */
  userAccounts: UserAccountLine[];
}

export interface FxPosition {
  currency: string;
  account: string;
  balance: string;
}

export interface SystemPositionsReport {
  currencies: { currency: string; accounts: SystemAccountLine[] }[];
  /** Raw per currency: there is no authoritative rate source to value them in a base currency. */
  fxPositions: FxPosition[];
}

export interface TrialBalanceReport {
  balanced: boolean;
  currencies: CurrencyTrialBalance[];
}

interface Group {
  _id: { currency: string; kind: AccountKind; walletType: string | null; accountType: string };
  balance: Types.Decimal128;
  debits: Types.Decimal128;
  credits: Types.Decimal128;
  accountCount: number;
}

const ZERO = Types.Decimal128.fromString('0');

@Injectable()
export class ReportsService {
  constructor(@InjectModel(Account.name) private readonly accounts: Model<AccountDoc>) {}

  async systemPositions(tenantId: string): Promise<SystemPositionsReport> {
    const accounts = await this.accounts
      .find({ tenantId, kind: 'system' })
      .sort({ currency: 1, accountType: 1 })
      .lean<AccountDoc[]>()
      .exec();

    const report: SystemPositionsReport = { currencies: [], fxPositions: [] };
    for (const a of accounts) {
      const balance = fromDecimal128(a.balance).toString();
      let currency = report.currencies.at(-1);
      if (currency?.currency !== a.currency) {
        currency = { currency: a.currency, accounts: [] };
        report.currencies.push(currency);
      }
      if (a.accountType === System.fx(a.currency)) {
        report.fxPositions.push({ currency: a.currency, account: a.accountType, balance });
      } else {
        currency.accounts.push({ name: a.accountType, balance });
      }
    }
    return report;
  }

  /** Live, from materialized balances, read as one snapshot so a concurrent post() cannot skew it. */
  async trialBalance(tenantId: string): Promise<TrialBalanceReport> {
    const groups = await this.accounts
      .aggregate<Group>([
        { $match: { tenantId } },
        {
          $group: {
            _id: { currency: '$currency', kind: '$kind', walletType: '$walletType', accountType: '$accountType' },
            balance: { $sum: '$balance' },
            // Per account, before aggregation, so a negative and a positive wallet do not cancel out.
            debits: { $sum: { $cond: [{ $lt: ['$balance', ZERO] }, { $abs: '$balance' }, ZERO] } },
            credits: { $sum: { $cond: [{ $gt: ['$balance', ZERO] }, '$balance', ZERO] } },
            accountCount: { $sum: 1 },
          },
        },
        { $sort: { '_id.currency': 1, '_id.walletType': 1, '_id.accountType': 1 } },
      ])
      .readConcern('snapshot')
      .exec();
    const byCurrency = new Map<string, { debits: bigint; credits: bigint; system: SystemAccountLine[]; user: UserAccountLine[] }>();
    for (const g of groups) {
      const { currency, kind, walletType, accountType } = g._id;
      if (!byCurrency.has(currency)) byCurrency.set(currency, { debits: 0n, credits: 0n, system: [], user: [] });
      const c = byCurrency.get(currency)!;
      c.debits += fromDecimal128(g.debits);
      c.credits += fromDecimal128(g.credits);
      const balance = fromDecimal128(g.balance).toString();
      if (kind === 'system') c.system.push({ name: accountType, balance });
      else c.user.push({ walletType: walletType!, accountType, accountCount: g.accountCount, balance });
    }

    const currencies = [...byCurrency.entries()].map(([currency, c]): CurrencyTrialBalance => {
      const net = c.credits - c.debits;
      return {
        currency,
        totalDebits: c.debits.toString(),
        totalCredits: c.credits.toString(),
        net: net.toString(),
        balanced: net === 0n,
        systemAccounts: c.system,
        userAccounts: c.user,
      };
    });
    return { balanced: currencies.every((c) => c.balanced), currencies };
  }
}
