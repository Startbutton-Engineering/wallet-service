import { Inject, Injectable } from "@nestjs/common";
import { CLOCK } from "../common/clock";
import type { Clock } from "../common/clock";
import { QueryFilter, Types } from "mongoose";
import { AccountDoc } from "../accounts/account";
import { AccountCheck, AccountReconciler } from "./account-reconciler";
import { AlertService } from "./alerts/alert.service";
import { LedgerInvariants } from "./ledger-invariants";
import { RunsRepository } from "./runs.repository";
import { ReconciliationRunDoc, TrialBalanceLine } from "./schemas/reconciliation-run.schema";
import {
  AlertKeyPrefix,
  balanceMismatch,
  Finding,
  mismatchKey,
  toAlert,
  trialBalanceFindings,
  unbalancedEntry,
} from "./findings";

export type RunKind = 'daily' | 'manual' | 'owner';
export type FullRunKind = Exclude<RunKind, 'owner'>;
export type RunStatus = 'ok' | 'mismatch';

export interface RunView {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date;
  accountsChecked: number;
  mismatchCount: number;
  ownerId?: string;
  currency?: string | null;
  runDate?: string;
  attempt?: number;
  /** Full runs only: an owner's accounts never net to zero on their own. */
  trialBalance?: TrialBalanceLine[];
}

export interface RunResult {
  run: ReconciliationRunDoc;
  findings: Finding[];
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly reconciler: AccountReconciler,
    private readonly invariants: LedgerInvariants,
    private readonly alerts: AlertService,
    private readonly runs: RunsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async trigger(kind: FullRunKind, daily?: { runDate: string; attempt: number }): Promise<RunResult> {
    const startedAt = this.clock.now();
    let accountsChecked = 0;
    const suspects: AccountCheck[] = [];
    for await (const batch of this.reconciler.check()) {
      accountsChecked += batch.length;
      suspects.push(...batch.filter(isMismatch));
    }
    const mismatches = (await this.confirm(suspects)).map(balanceMismatch);
    const trialBalance = await this.invariants.trialBalance();
    const unbalanced = await this.invariants.unbalancedEntries();

    const findings: Finding[] = [
      ...mismatches,
      ...trialBalanceFindings(trialBalance),
      ...unbalanced.map(unbalancedEntry),
    ];
    const run: ReconciliationRunDoc = {
      _id: new Types.ObjectId(),
      kind,
      status: findings.length === 0 ? 'ok' : 'mismatch',
      tenantId: null,
      ownerId: null,
      currency: null,
      runDate: daily?.runDate ?? null,
      attempt: daily?.attempt ?? null,
      accountsChecked,
      mismatchCount: mismatches.length,
      trialBalance: trialBalance.map((r) => ({
        tenantId: r.tenantId,
        currency: r.currency,
        balancesNet: r.balancesNet.toString(),
        postingsNet: r.postingsNet.toString(),
      })),
      startedAt,
      finishedAt: this.clock.now(),
    };
    await this.runs.record(run, findings);
    await this.alerts.sync({ prefixes: Object.values(AlertKeyPrefix) }, findings.map(toAlert));
    return { run, findings };
  }

  async triggerForOwner(tenantId: string, ownerId: string, currency?: string): Promise<RunResult> {
    const startedAt = this.clock.now();
    const filter: QueryFilter<AccountDoc> = { tenantId, ownerId, kind: 'user', ...(currency ? { currency } : {}) };
    const checkedKeys: string[] = [];
    const suspects: AccountCheck[] = [];
    for await (const batch of this.reconciler.check(filter)) {
      checkedKeys.push(...batch.map((c) => mismatchKey(tenantId, c.account._id.toHexString())));
      suspects.push(...batch.filter(isMismatch));
    }
    const findings = (await this.confirm(suspects)).map(balanceMismatch);
    const run: ReconciliationRunDoc = {
      _id: new Types.ObjectId(),
      kind: 'owner',
      status: findings.length === 0 ? 'ok' : 'mismatch',
      tenantId,
      ownerId,
      currency: currency ?? null,
      runDate: null,
      attempt: null,
      accountsChecked: checkedKeys.length,
      mismatchCount: findings.length,
      trialBalance: [],
      startedAt,
      finishedAt: this.clock.now(),
    };
    await this.runs.record(run, findings);
    await this.alerts.sync({ keys: checkedKeys }, findings.map(toAlert));
    return { run, findings };
  }

  /** Re-check suspects in a fresh snapshot so only a mismatch seen twice is reported. */
  private async confirm(suspects: AccountCheck[]): Promise<AccountCheck[]> {
    if (suspects.length === 0) return [];
    const filter: QueryFilter<AccountDoc> = { _id: { $in: suspects.map((s) => s.account._id) } };
    const confirmed: AccountCheck[] = [];
    for await (const batch of this.reconciler.check(filter)) confirmed.push(...batch.filter(isMismatch));
    return confirmed;
  }
}

/** A run as one tenant may see it: full runs span every tenant, so other tenants' rows are cut. */
export function runView(run: ReconciliationRunDoc, tenantId: string): RunView {
  const view: RunView = {
    runId: run._id.toHexString(),
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    accountsChecked: run.accountsChecked,
    mismatchCount: run.mismatchCount,
  };
  if (run.kind === 'owner') return { ...view, ownerId: run.ownerId!, currency: run.currency };
  const trialBalance = run.trialBalance.filter((r) => r.tenantId === tenantId);
  if (run.kind === 'daily') return { ...view, runDate: run.runDate!, attempt: run.attempt!, trialBalance };
  return { ...view, trialBalance };
}

export function forTenant(result: RunResult, tenantId: string): RunView & { findings: Finding[] } {
  return { ...runView(result.run, tenantId), findings: result.findings.filter((f) => f.tenantId === tenantId) };
}

function isMismatch(check: AccountCheck): boolean {
  return check.expected !== check.actual;
}
