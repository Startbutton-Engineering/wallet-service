import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AccountReconciler } from "./account-reconciler";
import { LedgerInvariants } from "./ledger-invariants";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { LEDGER_ALERT_NOTIFIER } from "./alerts/ledger-alert";
import { SlackNotifier } from "./alerts/slack-notifier";
import { AlertService } from "./alerts/alert.service";
import { LedgerAlertRecord, LedgerAlertSchema } from "./alerts/ledger-alert.schema";
import { RunsRepository } from "./runs.repository";
import { ReconciliationScheduler } from "./reconciliation.scheduler";
import { CLOCK, SystemClock } from "../common/clock";
import { LeaseRepository, Lock, LockSchema } from "./lease.repository";
import { DailyClaim, DailyClaimSchema, DailyClaimsRepository } from "./daily-claims.repository";
import { ReconciliationRun, ReconciliationRunSchema } from "./schemas/reconciliation-run.schema";
import { ReconciliationFinding, ReconciliationFindingSchema } from "./schemas/reconciliation-finding.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LedgerAlertRecord.name, schema: LedgerAlertSchema },
      { name: ReconciliationRun.name, schema: ReconciliationRunSchema },
      { name: ReconciliationFinding.name, schema: ReconciliationFindingSchema },
      { name: Lock.name, schema: LockSchema },
      { name: DailyClaim.name, schema: DailyClaimSchema },
    ]),
  ],
  controllers: [ReconciliationController],
  providers: [
    AccountReconciler,
    LedgerInvariants,
    ReconciliationService,
    AlertService,
    RunsRepository,
    ReconciliationScheduler,
    LeaseRepository,
    DailyClaimsRepository,
    { provide: CLOCK, useClass: SystemClock },
    { provide: LEDGER_ALERT_NOTIFIER, useClass: SlackNotifier },
  ],
  exports: [RunsRepository],
})
export class ReconciliationModule {}
