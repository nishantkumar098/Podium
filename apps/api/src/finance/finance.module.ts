import { Module } from "@nestjs/common";
import { BudgetsService } from "./budgets.service";
import { BudgetsController, ExpensesController } from "./finance.controller";
import { ExpensesService } from "./expenses.service";

@Module({
  controllers: [BudgetsController, ExpensesController],
  providers: [BudgetsService, ExpensesService],
  // ReportsService reads budget variance for the P&L screen in Phase C.
  exports: [BudgetsService, ExpensesService],
})
export class FinanceModule {}
