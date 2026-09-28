import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { PnlStatementsController } from "./pnl-statements.controller";
import { PnlStatementsService } from "./pnl-statements.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [FinanceModule],
  controllers: [ReportsController, PnlStatementsController],
  providers: [ReportsService, PnlStatementsService],
})
export class ReportsModule {}
