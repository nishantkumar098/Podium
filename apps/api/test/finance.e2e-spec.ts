import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase B — budgets and expenses.
 *
 * The approval tests matter more than the CRUD ones: this is a path that
 * moves real money to real people, so the state machine is asserted against
 * database state (status, approver id, audit rows), not just HTTP codes.
 */
describe("Finance — budgets & expenses (e2e)", () => {
  let app: INestApplication;
  let finance: string; // Neha, Finance Manager — holds expenses:approve
  let founder: string; // Anant, Founder — holds everything
  let projectId: string;
  const createdExpenseIds: string[] = [];
  let budgetId: string | null = null;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    finance = await loginAs(app, "neha.agarwal@ammbrands.in");
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    projectId = project.id;
    // Start from a clean budget for this project so assertions are exact.
    await prisma.budgetLine.deleteMany({ where: { budget: { projectId } } });
    await prisma.budget.deleteMany({ where: { projectId } });
  });

  afterAll(async () => {
    if (createdExpenseIds.length) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: createdExpenseIds } } });
      await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
    }
    await prisma.budgetLine.deleteMany({ where: { budget: { projectId } } });
    await prisma.budget.deleteMany({ where: { projectId } });
    await app.close();
  });

  const as = (token: string) => ({
    post: (p: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(b ?? {}),
    get: (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${token}`),
    patch: (p: string, b?: unknown) => request(app.getHttpServer()).patch(p).set("Authorization", `Bearer ${token}`).send(b ?? {}),
    del: (p: string) => request(app.getHttpServer()).delete(p).set("Authorization", `Bearer ${token}`),
  });

  async function submitExpense(token: string, over: { category?: string; amount?: number } = {}) {
    const res = await as(token).post("/api/expenses", {
      projectId,
      category: over.category ?? "Transport & Logistics",
      amount: over.amount ?? 5000,
      note: "Phase B test claim",
    });
    expect(res.status).toBe(201);
    createdExpenseIds.push(res.body.id);
    return res.body.id as string;
  }

  // ------------------------------------------------------------- budgets
  describe("budgets", () => {
    it("creates a budget with lines and reads it back", async () => {
      const res = await as(finance).post("/api/budgets", {
        projectId,
        lines: [
          { category: "Transport & Logistics", plannedAmount: 40000 },
          { category: "Catering", plannedAmount: 150000 },
        ],
      });
      expect(res.status).toBe(201);
      budgetId = res.body.id;
      expect(res.body.lines).toHaveLength(2);

      const stored = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId! }, include: { lines: true } });
      expect(stored.lines).toHaveLength(2);
      expect(stored.createdById).toBeTruthy();
    });

    it("refuses a second budget for the same project", async () => {
      const res = await as(finance).post("/api/budgets", {
        projectId,
        lines: [{ category: "Catering", plannedAmount: 1 }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already has a budget/i);
    });

    it("refuses duplicate categories — variance could not attribute an expense", async () => {
      const other = await prisma.project.findFirstOrThrow({ where: { id: { not: projectId }, deletedAt: null } });
      const res = await as(finance).post("/api/budgets", {
        projectId: other.id,
        lines: [
          { category: "Catering", plannedAmount: 100 },
          { category: "catering", plannedAmount: 200 },
        ],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/more than once/i);
    });

    it("replaces lines wholesale on update", async () => {
      const res = await as(finance).patch(`/api/budgets/${budgetId}`, {
        lines: [
          { category: "Transport & Logistics", plannedAmount: 60000 },
          { category: "Catering", plannedAmount: 150000 },
          { category: "Décor & Florals", plannedAmount: 90000 },
        ],
      });
      expect(res.status).toBe(200);
      const stored = await prisma.budgetLine.findMany({ where: { budgetId: budgetId! } });
      expect(stored).toHaveLength(3);
      expect(Number(stored.find((l) => l.category === "Transport & Logistics")!.plannedAmount)).toBe(60000);
    });

    it("rejects a caller without budgets:view", async () => {
      const sales = await loginAs(app, "ananya.joshi@ammbrands.in"); // Sales — no budgets grant
      const res = await request(app.getHttpServer())
        .get(`/api/budgets?projectId=${projectId}`)
        .set("Authorization", `Bearer ${sales}`);
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------ expenses
  describe("expense approval workflow", () => {
    it("submits a claim as PENDING, attributed to the caller", async () => {
      const id = await submitExpense(finance);
      const stored = await prisma.expense.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("PENDING");
      expect(stored.approvedById).toBeNull();
      const neha = await prisma.user.findFirstOrThrow({ where: { email: "neha.agarwal@ammbrands.in" } });
      expect(stored.userId).toBe(neha.id);
    });

    it("REFUSES self-approval even though the claimant holds expenses:approve", async () => {
      const id = await submitExpense(finance);
      const res = await as(finance).post(`/api/expenses/${id}/decide`, { decision: "APPROVED" });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/cannot decide your own/i);

      // And the claim genuinely did not move.
      const stored = await prisma.expense.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("PENDING");
      expect(stored.approvedById).toBeNull();
    });

    it("approves when a DIFFERENT user decides, recording who and when", async () => {
      const id = await submitExpense(finance);
      const res = await as(founder).post(`/api/expenses/${id}/decide`, { decision: "APPROVED" });
      expect(res.status).toBe(201);

      const stored = await prisma.expense.findUniqueOrThrow({ where: { id } });
      const anant = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
      expect(stored.status).toBe("APPROVED");
      expect(stored.approvedById).toBe(anant.id);
      expect(stored.decidedAt).not.toBeNull();

      const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "expense.approved" } });
      expect(audit).not.toBeNull();
      expect(audit!.actorId).toBe(anant.id);
    });

    it("REFUSES to re-decide a settled claim", async () => {
      const id = await submitExpense(finance);
      expect((await as(founder).post(`/api/expenses/${id}/decide`, { decision: "APPROVED" })).status).toBe(201);

      const again = await as(founder).post(`/api/expenses/${id}/decide`, { decision: "REJECTED", reason: "changed my mind" });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/cannot be decided again/i);
      expect((await prisma.expense.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
    });

    it("requires a reason to reject", async () => {
      const id = await submitExpense(finance);
      const noReason = await as(founder).post(`/api/expenses/${id}/decide`, { decision: "REJECTED" });
      expect(noReason.status).toBe(400);

      const withReason = await as(founder).post(`/api/expenses/${id}/decide`, {
        decision: "REJECTED",
        reason: "No receipt attached",
      });
      expect(withReason.status).toBe(201);
      const stored = await prisma.expense.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("REJECTED");
      expect(stored.decisionReason).toBe("No receipt attached");
    });

    it("only reimburses an APPROVED claim", async () => {
      const id = await submitExpense(finance);
      const tooEarly = await as(founder).post(`/api/expenses/${id}/reimburse`);
      expect(tooEarly.status).toBe(409);

      await as(founder).post(`/api/expenses/${id}/decide`, { decision: "APPROVED" });
      const ok = await as(founder).post(`/api/expenses/${id}/reimburse`);
      expect(ok.status).toBe(201);
      const stored = await prisma.expense.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("REIMBURSED");
      expect(stored.reimbursedAt).not.toBeNull();
    });

    it("is idempotent on submit with an Idempotency-Key", async () => {
      const key = `phase-b-${Date.now()}`;
      const body = { projectId, category: "Catering", amount: 1234 };
      const first = await request(app.getHttpServer())
        .post("/api/expenses").set("Authorization", `Bearer ${finance}`).set("Idempotency-Key", key).send(body);
      const second = await request(app.getHttpServer())
        .post("/api/expenses").set("Authorization", `Bearer ${finance}`).set("Idempotency-Key", key).send(body);
      expect(first.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      createdExpenseIds.push(first.body.id);
      expect(await prisma.expense.count({ where: { idempotencyKey: key } })).toBe(1);
    });
  });

  // ------------------------------------------------------- budget variance
  describe("budget vs actual", () => {
    // The approval tests above deliberately submit and approve claims in the
    // default category, so this block starts from a clean slate — otherwise
    // the variance assertions would be measuring their leftovers rather than
    // what this test sets up.
    beforeAll(async () => {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: createdExpenseIds } } });
      await prisma.expense.deleteMany({ where: { projectId } });
      createdExpenseIds.length = 0;
    });

    it("counts only committed expenses, separates unbudgeted spend, and never blends PO spend into categories", async () => {
      // Approved -> counts. Pending -> must NOT count.
      const approved = await submitExpense(finance, { category: "Transport & Logistics", amount: 12000 });
      await as(founder).post(`/api/expenses/${approved}/decide`, { decision: "APPROVED" });
      await submitExpense(finance, { category: "Transport & Logistics", amount: 999999 }); // stays PENDING

      // An expense in a category with no budget line at all.
      const unbudgeted = await submitExpense(finance, { category: "Unplanned Overtime", amount: 7000 });
      await as(founder).post(`/api/expenses/${unbudgeted}/decide`, { decision: "APPROVED" });

      const res = await as(finance).get(`/api/budgets/variance?projectId=${projectId}`);
      expect(res.status).toBe(200);
      const v = res.body;

      expect(v.hasBudget).toBe(true);
      const transport = v.lines.find((l: { category: string }) => l.category === "Transport & Logistics");
      expect(transport.plannedAmount).toBe(60000);
      expect(transport.actualAmount).toBe(12000); // the 999999 PENDING claim is excluded
      expect(transport.variance).toBe(48000);
      expect(transport.variancePct).toBe(80);

      // Unbudgeted spend is surfaced, not silently folded into the totals.
      expect(v.unbudgetedSpend).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: "Unplanned Overtime", actualAmount: 7000 })]),
      );

      // PO spend is its own figure — purchase orders carry no category.
      expect(v).toHaveProperty("purchaseOrderSpend");
      expect(v.totals.actualAllCommitted).toBe(v.totals.actualExpenses + v.purchaseOrderSpend);
      expect(v.totals.actualExpenses).toBe(19000); // 12000 + 7000, not the pending 999999
    });

    it("reports real spend even when a project has no budget at all", async () => {
      const other = await prisma.project.findFirstOrThrow({ where: { id: { not: projectId }, deletedAt: null } });
      const res = await as(finance).get(`/api/budgets/variance?projectId=${other.id}`);
      expect(res.status).toBe(200);
      expect(res.body.hasBudget).toBe(false);
      expect(res.body.lines).toEqual([]);
      expect(res.body.totals).toHaveProperty("actualAllCommitted");
    });

    it("is reachable through /reports/budget-variance with the same numbers", async () => {
      const viaBudgets = await as(finance).get(`/api/budgets/variance?projectId=${projectId}`);
      const viaReports = await as(finance).get(`/api/reports/budget-variance?projectId=${projectId}`);
      expect(viaReports.status).toBe(200);
      expect(viaReports.body).toEqual(viaBudgets.body);
    });
  });
});
