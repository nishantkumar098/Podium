import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateBudgetInput, UpdateBudgetInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

/** Expense states that represent money actually committed — mirrors ReportsService.COST_STATES. */
const COMMITTED_EXPENSE_STATES = ["APPROVED", "REIMBURSED"] as const;

export interface BudgetVariance {
  projectId: string;
  hasBudget: boolean;
  /** Per budget category: what was planned, what has actually been spent. */
  lines: Array<{
    category: string;
    plannedAmount: number;
    actualAmount: number;
    variance: number;
    /** null when planned is 0 — a percentage against nothing is meaningless, not 0%. */
    variancePct: number | null;
  }>;
  /**
   * Actual spend in categories that have no budget line at all. Surfaced
   * separately rather than folded into the totals, because "we spent money on
   * something nobody budgeted for" is a finding, not a rounding difference.
   */
  unbudgetedSpend: Array<{ category: string; actualAmount: number }>;
  /**
   * Received purchase-order spend. Purchase orders carry NO category field
   * (see PurchaseRequest/PurchaseOrder in schema.prisma), so there is no
   * honest way to attribute this to a budget category. It is reported as its
   * own figure rather than distributed across categories by guesswork.
   */
  purchaseOrderSpend: number;
  totals: {
    planned: number;
    /** Categorised expense actuals only — comparable, like for like, to `planned`. */
    actualExpenses: number;
    /** actualExpenses + purchaseOrderSpend: every rupee committed against this project. */
    actualAllCommitted: number;
    variance: number;
  };
}

/**
 * Project budgets (blueprint §18). A budget is a plan; it is never an actual.
 * This service reads actuals only from real committed transactions — approved
 * or reimbursed expenses, and purchase orders that have actually arrived —
 * exactly as ReportsService does, so the two can never disagree about what
 * "spent" means.
 */
@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  /** Loads the project and enforces the workspace + city grant in one place. */
  private async assertProject(user: RequestUser, projectId: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return project;
  }

  async getForProject(user: RequestUser, projectId: string) {
    await this.assertProject(user, projectId);
    return this.prisma.client.budget.findFirst({
      where: { projectId, deletedAt: null },
      include: { lines: { orderBy: { category: "asc" } } },
    });
  }

  async create(user: RequestUser, input: CreateBudgetInput) {
    await this.assertProject(user, input.projectId);

    // One budget per project. Allowing several would make "the project's
    // budget" ambiguous, and every variance report would have to guess which
    // one it meant.
    const existing = await this.prisma.client.budget.findFirst({
      where: { projectId: input.projectId, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException("This project already has a budget — update it instead of creating a second one.");
    }
    assertNoDuplicateCategories(input.lines);

    return this.prisma.client.budget.create({
      data: {
        projectId: input.projectId,
        createdById: user.id,
        lines: { create: input.lines.map((l) => ({ category: l.category.trim(), plannedAmount: l.plannedAmount })) },
      },
      include: { lines: true },
    });
  }

  async update(user: RequestUser, budgetId: string, input: UpdateBudgetInput) {
    const budget = await this.prisma.client.budget.findFirst({
      where: { id: budgetId, deletedAt: null },
      include: { project: true },
    });
    if (!budget || budget.project.workspaceId !== user.workspaceId) throw new NotFoundException("Budget not found.");
    this.cityScope.assertCanAccessCity(user, budget.project.cityId);
    assertNoDuplicateCategories(input.lines);

    // Replace the line set atomically: a partially-applied budget edit would
    // leave a plan that sums to a number nobody approved.
    return this.prisma.client.$transaction(async (tx) => {
      await tx.budgetLine.deleteMany({ where: { budgetId } });
      await tx.budgetLine.createMany({
        data: input.lines.map((l) => ({ budgetId, category: l.category.trim(), plannedAmount: l.plannedAmount })),
      });
      return tx.budget.findUniqueOrThrow({ where: { id: budgetId }, include: { lines: { orderBy: { category: "asc" } } } });
    });
  }

  async remove(user: RequestUser, budgetId: string) {
    const budget = await this.prisma.client.budget.findFirst({
      where: { id: budgetId, deletedAt: null },
      include: { project: true },
    });
    if (!budget || budget.project.workspaceId !== user.workspaceId) throw new NotFoundException("Budget not found.");
    this.cityScope.assertCanAccessCity(user, budget.project.cityId);
    return this.prisma.client.budget.update({ where: { id: budgetId }, data: { deletedAt: new Date() } });
  }

  /**
   * Budget vs. actual for one project. Every actual here is a real committed
   * transaction — nothing is estimated, prorated or forecast. A project with
   * no budget returns `hasBudget: false` and still reports its real spend,
   * rather than an empty result that reads as "nothing was spent".
   */
  async variance(user: RequestUser, projectId: string): Promise<BudgetVariance> {
    await this.assertProject(user, projectId);

    const [budget, expenses, orders] = await Promise.all([
      this.prisma.client.budget.findFirst({
        where: { projectId, deletedAt: null },
        include: { lines: { orderBy: { category: "asc" } } },
      }),
      this.prisma.client.expense.groupBy({
        by: ["category"],
        where: { projectId, deletedAt: null, status: { in: [...COMMITTED_EXPENSE_STATES] } },
        _sum: { amount: true },
      }),
      this.prisma.client.purchaseOrder.findMany({
        where: {
          deletedAt: null,
          status: { in: ["PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"] },
          purchaseRequest: { projectId },
        },
        select: { total: true },
      }),
    ]);

    const actualByCategory = new Map<string, number>();
    for (const row of expenses) actualByCategory.set(row.category, Number(row._sum.amount ?? 0));

    const lines = (budget?.lines ?? []).map((l) => {
      const planned = Number(l.plannedAmount);
      const actual = actualByCategory.get(l.category) ?? 0;
      actualByCategory.delete(l.category); // what's left over is unbudgeted
      return {
        category: l.category,
        plannedAmount: planned,
        actualAmount: actual,
        variance: planned - actual,
        variancePct: planned > 0 ? round2(((planned - actual) / planned) * 100) : null,
      };
    });

    const unbudgetedSpend = [...actualByCategory.entries()]
      .map(([category, actualAmount]) => ({ category, actualAmount }))
      .sort((a, b) => b.actualAmount - a.actualAmount);

    const purchaseOrderSpend = orders.reduce((s, o) => s + Number(o.total), 0);
    const planned = lines.reduce((s, l) => s + l.plannedAmount, 0);
    const actualExpenses =
      lines.reduce((s, l) => s + l.actualAmount, 0) + unbudgetedSpend.reduce((s, u) => s + u.actualAmount, 0);

    return {
      projectId,
      hasBudget: Boolean(budget),
      lines,
      unbudgetedSpend,
      purchaseOrderSpend,
      totals: {
        planned,
        actualExpenses,
        actualAllCommitted: actualExpenses + purchaseOrderSpend,
        variance: planned - actualExpenses,
      },
    };
  }
}

function assertNoDuplicateCategories(lines: Array<{ category: string }>): void {
  const seen = new Set<string>();
  for (const l of lines) {
    const key = l.category.trim().toLowerCase();
    if (seen.has(key)) {
      throw new ConflictException(
        `Category "${l.category.trim()}" appears more than once. Each category gets one budget line, ` +
          "otherwise the variance report cannot say which line an expense belongs to.",
      );
    }
    seen.add(key);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
