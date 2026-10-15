import { Module } from "@nestjs/common";
import { ReconciliationModule } from "../reconciliation/reconciliation.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [ReconciliationModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
