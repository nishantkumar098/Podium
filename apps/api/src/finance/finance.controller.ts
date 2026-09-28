import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  createBudgetSchema,
  createExpenseSchema,
  decideExpenseSchema,
  updateBudgetSchema,
} from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { BudgetsService } from "./budgets.service";
import { ExpensesService } from "./expenses.service";

@Controller("budgets")
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermissions("budgets:view")
  forProject(@CurrentUser() user: RequestUser, @Query("projectId", ParseUUIDPipe) projectId: string) {
    return this.budgets.getForProject(user, projectId);
  }

  /** Budget vs. actual. Actuals are real committed transactions only. */
  @Get("variance")
  @RequirePermissions("budgets:view")
  variance(@CurrentUser() user: RequestUser, @Query("projectId", ParseUUIDPipe) projectId: string) {
    return this.budgets.variance(user, projectId);
  }

  @Post()
  @RequirePermissions("budgets:create")
  @Audit("budget", "budget.create")
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createBudgetSchema)) body: ReturnType<typeof createBudgetSchema.parse>,
  ) {
    return this.budgets.create(user, body);
  }

  @Patch(":id")
  @RequirePermissions("budgets:edit")
  @Audit("budget", "budget.update")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateBudgetSchema)) body: ReturnType<typeof updateBudgetSchema.parse>,
  ) {
    return this.budgets.update(user, id, body);
  }

  @Delete(":id")
  @RequirePermissions("budgets:delete")
  @Audit("budget", "budget.delete")
  remove(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgets.remove(user, id);
  }
}

@Controller("expenses")
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermissions("expenses:view")
  list(
    @CurrentUser() user: RequestUser,
    @Query("projectId") projectId?: string,
    @Query("status") status?: string,
    @Query("mine") mine?: string,
  ) {
    return this.expenses.list(user, { projectId, status, mine: mine === "true" });
  }

  @Get(":id")
  @RequirePermissions("expenses:view")
  get(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.expenses.get(user, id);
  }

  @Post()
  @RequirePermissions("expenses:create")
  @Audit("expense", "expense.submit")
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createExpenseSchema)) body: ReturnType<typeof createExpenseSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.expenses.create(user, body, idempotencyKey);
  }

  /**
   * PENDING -> APPROVED | REJECTED. Refuses self-approval and re-deciding.
   *
   * No @Audit() here on purpose: ExpensesService.decide writes its own
   * audit row inside the same transaction as the status change, carrying the
   * before/after status, the amount and the claimant. The interceptor would
   * add a second, thinner row for the same event — two audit entries per
   * decision makes the trail harder to read, not more trustworthy.
   */
  @Post(":id/decide")
  @RequirePermissions("expenses:approve")
  decide(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(decideExpenseSchema)) body: ReturnType<typeof decideExpenseSchema.parse>,
  ) {
    return this.expenses.decide(user, id, body);
  }

  /** Audited inside the service transaction — see decide() above. */
  @Post(":id/reimburse")
  @RequirePermissions("expenses:approve")
  reimburse(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.expenses.reimburse(user, id);
  }

  /** The claimant withdrawing their own still-PENDING claim. */
  @Delete(":id")
  @RequirePermissions("expenses:create")
  @Audit("expense", "expense.withdraw")
  withdraw(@CurrentUser() user: RequestUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.expenses.withdraw(user, id);
  }
}
