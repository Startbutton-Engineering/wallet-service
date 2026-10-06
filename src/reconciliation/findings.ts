import { AccountCheck } from "./account-reconciler";
import { Firing } from "./alerts/alert.service";
import { TrialBalanceRow, UnbalancedEntry } from "./ledger-invariants";

export interface BalanceMismatchFinding {
  type: 'balance-mismatch';
  tenantId: string;
  accountId: string;
  ownerId: string | null;
  currency: string;
  walletType: string | null;
  accountType: string;
  expected: string;
  actual: string;
  difference: string;
  postingCount: number;
}

export interface TrialBalanceFinding {
  type: 'trial-balance';
  source: 'balances' | 'postings';
  tenantId: string;
  currency: string;
  net: string;
}

export interface UnbalancedEntryFinding {
  type: 'unbalanced-entry';
  tenantId: string;
  entryId: string;
  currency: string;
  net: string;
}

export type Finding = BalanceMismatchFinding | TrialBalanceFinding | UnbalancedEntryFinding;

export const AlertKeyPrefix = {
  mismatch: 'recon:mismatch:',
  trialBalance: 'trial-balance:',
  unbalancedEntry: 'unbalanced-entry:',
} as const;

export function mismatchKey(tenantId: string, accountId: string): string {
  return `${AlertKeyPrefix.mismatch}${tenantId}:${accountId}`;
}

export function balanceMismatch(check: AccountCheck): BalanceMismatchFinding {
  const { account } = check;
  return {
    type: 'balance-mismatch',
    tenantId: account.tenantId,
    accountId: account._id.toHexString(),
    ownerId: account.ownerId,
    currency: account.currency,
    walletType: account.walletType,
    accountType: account.accountType,
    expected: check.expected.toString(),
    actual: check.actual.toString(),
    difference: (check.actual - check.expected).toString(),
    postingCount: check.postingCount,
  };
}

export function trialBalanceFindings(rows: TrialBalanceRow[]): TrialBalanceFinding[] {
  const findings: TrialBalanceFinding[] = [];
  for (const row of rows) {
    for (const source of ['balances', 'postings'] as const) {
      const net = source === 'balances' ? row.balancesNet : row.postingsNet;
      if (net !== 0n) {
        findings.push({ type: 'trial-balance', source, tenantId: row.tenantId, currency: row.currency, net: net.toString() });
      }
    }
  }
  return findings;
}

export function unbalancedEntry(entry: UnbalancedEntry): UnbalancedEntryFinding {
  return { type: 'unbalanced-entry', ...entry, net: entry.net.toString() };
}

export function toAlert(finding: Finding): Firing {
  switch (finding.type) {
    case 'balance-mismatch':
      return {
        key: mismatchKey(finding.tenantId, finding.accountId),
        title: 'Ledger balance mismatch',
        fields: {
          Tenant: finding.tenantId,
          Account: `${finding.accountType} ${finding.currency} (${finding.accountId})`,
          Owner: finding.ownerId ?? 'system',
          'Sum of postings': finding.expected,
          'Materialized balance': finding.actual,
          Difference: finding.difference,
        },
      };
    case 'trial-balance':
      return {
        key: `${AlertKeyPrefix.trialBalance}${finding.source}:${finding.tenantId}:${finding.currency}`,
        title: 'Trial balance is not zero',
        fields: {
          Tenant: finding.tenantId,
          Currency: finding.currency,
          'Summed from': finding.source === 'balances' ? 'materialized balances' : 'postings',
          Net: finding.net,
        },
      };
    case 'unbalanced-entry':
      return {
        key: `${AlertKeyPrefix.unbalancedEntry}${finding.tenantId}:${finding.entryId}`,
        title: 'Unbalanced ledger entry',
        fields: {
          Tenant: finding.tenantId,
          Entry: finding.entryId,
          Currency: finding.currency,
          Net: finding.net,
        },
      };
  }
}
