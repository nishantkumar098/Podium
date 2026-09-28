import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@podium/db";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { allowedCityIds, type RequestUser } from "../common/types";

export type Scope = "company" | "city" | "project";

/**
 * Invoice states that represent real, recognised revenue. DRAFT is excluded:
 * an unissued invoice is not revenue, and CANCELLED never was.
 */
const REVENUE_STATES = ["ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE"] as const;
/** Expense states that represent money actually committed. */
const COST_STATES = ["APPROVED", "REIMBURSED"] as const;

export interface PnlActuals {
  kind: "actuals";
  scope: Scope;
  from: string;
  to: string;
  /**
   * False when there is no real financial data in range. Callers must render
   * the explanation rather than a zero that looks like a computed result.
   */
  hasData: boolean;
  explanation: string | null;
  revenue: {
    /** Ex-GST. Tax collected is not revenue — it is money held for the state. */
    netRevenue: number;
    gstCollected: number;
    grossInvoiced: number;
    invoiceCount: number;
  };
  collections: { received: number; outstanding: number; paymentCount: number };
  costs: { expenses: number; purchaseOrders: number; total: number };
  margin: { grossMargin: number; grossMarginPct: number | null };
}

/**
 * Reports (blueprint §18). Two hard rules, both enforced structurally rather
 * than by convention:
 *
 *  1. **Actuals are computed only from real transactions** — invoices,
 *     payments, expenses, received purchase orders. There is no default, no
 *     assumed run-rate, and no filling of empty periods.
 *  2. **Forecast is never blended into an actuals figure.** They are separate
 *     endpoints returning separately-typed objects with an explicit `kind`, so
 *     a caller cannot accidentally sum them. A forecast with no actuals to
 *     anchor on refuses to produce numbers at all.
 *
 * As of the real-data import the database holds zero projects and zero
 * invoices (see STATUS.md §0.-1), so every actuals figure below is genuinely
 * zero and `hasData` is false. That is the correct output, not a bug.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  /**
   * Reports & Analytics (People & governance): the business at a glance.
   * Every ratio is null — not 0% — when there is nothing to divide by, so
   * "no data yet" is never shown as "we scored zero".
   */
  async analytics(user: RequestUser) {
    const scope = this.cityScope.scopeFilter(user);
    const projects = await this.prisma.client.project.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...scope },
      select: { type: true, revenue: true, actCost: true, city: { select: { name: true } } },
    });

    // Imported event types are free text ("DIWALI PARTY", "Wedding", "BAR"):
    // grouped case-insensitively, the eight largest kept, the rest as Other.
    const types = new Map<string, { type: string; revenue: number; count: number }>();
    for (const p of projects) {
      const label = p.type.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) || "Unspecified";
      const t = types.get(label) ?? { type: label, revenue: 0, count: 0 };
      t.revenue += p.revenue.toNumber();
      t.count += 1;
      types.set(label, t);
    }
    const ranked = [...types.values()].sort((a, b) => b.revenue - a.revenue || b.count - a.count);
    const byType = ranked.slice(0, 8);
    const rest = ranked.slice(8);
    if (rest.length) {
      byType.push({ type: `Other (${rest.length} types)`, revenue: sum(rest.map((r) => r.revenue)), count: sum(rest.map((r) => r.count)) });
    }

    const cityCounts = new Map<string, number>();
    for (const p of projects) cityCounts.set(p.city.name, (cityCounts.get(p.city.name) ?? 0) + 1);

    const revenue = sum(projects.map((p) => p.revenue.toNumber()));
    const cost = sum(projects.map((p) => p.actCost.toNumber()));

    const [tasksTotal, tasksDone, vendorRating, pipelineTotal, pipelineWon] = await Promise.all([
      this.prisma.client.task.count({ where: { deletedAt: null, project: { workspaceId: user.workspaceId, ...scope } } }),
      this.prisma.client.task.count({ where: { deletedAt: null, status: "COMPLETED", project: { workspaceId: user.workspaceId, ...scope } } }),
      this.prisma.client.vendor.aggregate({
        where: { workspaceId: user.workspaceId, deletedAt: null, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      this.prisma.client.lead.count({ where: { workspaceId: user.workspaceId, kind: "PIPELINE" } }),
      this.prisma.client.lead.count({ where: { workspaceId: user.workspaceId, kind: "PIPELINE", stage: "WON" } }),
    ]);

    return {
      projects: projects.length,
      revenueByType: byType,
      projectsByCity: [...cityCounts.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
      margin: revenue > 0 ? { pct: round2(((revenue - cost) / revenue) * 100), revenue, cost } : null,
      taskCompletion: tasksTotal > 0 ? { pct: Math.round((tasksDone / tasksTotal) * 100), done: tasksDone, total: tasksTotal } : null,
      vendorRating:
        vendorRating._count.rating > 0 ? { avg: round2(vendorRating._avg.rating?.toNumber() ?? 0), rated: vendorRating._count.rating } : null,
      salesConversion: pipelineTotal > 0 ? { pct: Math.round((pipelineWon / pipelineTotal) * 100), won: pipelineWon, total: pipelineTotal } : null,
    };
  }

  private range(from?: string, to?: string) {
    const start = from ? new Date(from) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const end = to ? new Date(to) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException("from/to must be ISO dates.");
    }
    if (start > end) throw new BadRequestException("`from` must be before `to`.");
    return { start, end };
  }

  /** The set of cities this caller may see, as a concrete list for SQL. */
  private async visibleCityIds(user: RequestUser, requestedCityId?: string): Promise<string[]> {
    if (requestedCityId) {
      this.cityScope.assertCanAccessCity(user, requestedCityId);
      return [requestedCityId];
    }
    const allowed = allowedCityIds(user);
    if (allowed !== "ALL") return allowed;
    const cities = await this.prisma.client.city.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null }, select: { id: true },
    });
    return cities.map((c) => c.id);
  }

  async pnl(
    user: RequestUser,
    opts: { scope: Scope; cityId?: string; projectId?: string; from?: string; to?: string },
  ): Promise<PnlActuals> {
    const { start, end } = this.range(opts.from, opts.to);

    let cityIds = await this.visibleCityIds(user, opts.cityId);
    let projectIds: string[] | null = null;

    if (opts.scope === "project") {
      if (!opts.projectId) throw new BadRequestException("scope=project needs a projectId.");
      const project = await this.prisma.client.project.findFirst({
        where: { id: opts.projectId, workspaceId: user.workspaceId, deletedAt: null },
      });
      if (!project) throw new BadRequestException("Project not found.");
      this.cityScope.assertCanAccessCity(user, project.cityId);
      projectIds = [project.id];
      cityIds = [project.cityId];
    }
    if (opts.scope === "city" && !opts.cityId) {
      throw new BadRequestException("scope=city needs a cityId.");
    }

    const invoiceWhere: Prisma.InvoiceWhereInput = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      status: { in: [...REVENUE_STATES] },
      cityId: { in: cityIds },
      issueDate: { gte: start, lte: end },
      ...(projectIds ? { projectId: { in: projectIds } } : {}),
    };

    const invoices = await this.prisma.client.invoice.findMany({
      where: invoiceWhere,
      select: { id: true, taxableAmount: true, cgst: true, sgst: true, igst: true, total: true },
    });
    const invoiceIds = invoices.map((i) => i.id);

    const netRevenue = sum(invoices.map((i) => Number(i.taxableAmount)));
    const gstCollected = sum(invoices.map((i) => Number(i.cgst) + Number(i.sgst) + Number(i.igst)));
    const grossInvoiced = sum(invoices.map((i) => Number(i.total)));

    const payments = invoiceIds.length
      ? await this.prisma.client.payment.findMany({
          where: { invoiceId: { in: invoiceIds }, receivedAt: { gte: start, lte: end } },
          select: { amount: true },
        })
      : [];
    const received = sum(payments.map((p) => Number(p.amount)));

    const expenses = await this.prisma.client.expense.findMany({
      where: {
        deletedAt: null,
        status: { in: [...COST_STATES] },
        incurredAt: { gte: start, lte: end },
        project: { workspaceId: user.workspaceId, cityId: { in: cityIds }, ...(projectIds ? { id: { in: projectIds } } : {}) },
      },
      select: { amount: true },
    });
    const expenseTotal = sum(expenses.map((e) => Number(e.amount)));

    // Only purchase orders that actually arrived count as cost — a sent PO is
    // a commitment, not a cost incurred.
    const orders = await this.prisma.client.purchaseOrder.findMany({
      where: {
        deletedAt: null,
        status: { in: ["PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"] },
        createdAt: { gte: start, lte: end },
        purchaseRequest: {
          cityId: { in: cityIds },
          ...(projectIds ? { projectId: { in: projectIds } } : {}),
        },
      },
      select: { total: true },
    });
    const poTotal = sum(orders.map((o) => Number(o.total)));

    const costs = expenseTotal + poTotal;
    const grossMargin = netRevenue - costs;
    const hasData = invoices.length > 0 || payments.length > 0 || expenses.length > 0 || orders.length > 0;

    return {
      kind: "actuals",
      scope: opts.scope,
      from: start.toISOString(),
      to: end.toISOString(),
      hasData,
      explanation: hasData
        ? null
        : "No issued invoices, payments, approved expenses or received purchase orders fall in this range — " +
          "this is an empty result, not a computed zero. Figures appear as soon as invoices are issued or costs are recorded.",
      revenue: { netRevenue, gstCollected, grossInvoiced, invoiceCount: invoices.length },
      collections: { received, outstanding: grossInvoiced - received, paymentCount: payments.length },
      costs: { expenses: expenseTotal, purchaseOrders: poTotal, total: costs },
      margin: { grossMargin, grossMarginPct: netRevenue > 0 ? round2((grossMargin / netRevenue) * 100) : null },
    };
  }

  /** Per-city breakdown, each entry computed exactly like the company figure. */
  async pnlByCity(user: RequestUser, from?: string, to?: string) {
    const cityIds = await this.visibleCityIds(user);
    const cities = await this.prisma.client.city.findMany({
      where: { id: { in: cityIds } }, select: { id: true, name: true, code: true },
    });
    // All cities at once: each is ~5 independent queries, and one city at a
    // time made this screen wait on six sequential batches.
    const rows: Array<{ city: { id: string; name: string; code: string } } & PnlActuals> = await Promise.all(
      cities.map(async (city) => ({ city, ...(await this.pnl(user, { scope: "city", cityId: city.id, from, to })) })),
    );
    return { kind: "actuals" as const, cities: rows, hasData: rows.some((r) => r.hasData) };
  }

  /**
   * Project finance: money per project, every figure from real records.
   *
   *   booked      project.revenue — the value the event was won at
   *   invoiced    taxable value of issued tax invoices (revenue recognised)
   *   collected   payments received against those invoices
   *   receivable  what is still owed on issued invoices, after credit/debit notes
   *   cost        approved expense claims + purchase orders whose goods arrived
   *               (the same cost basis as the P&L), and project.actCost where
   *               the team entered it directly
   *   committed   purchase orders sent but not yet received — owed to vendors soon
   *
   * Four grouped SQL queries for the whole company, not one per project.
   */
  async projectFinance(user: RequestUser, cityId?: string) {
    const cityIds = await this.visibleCityIds(user, cityId);
    const db = this.prisma.client;
    const [projects, money, expenses, orders] = await Promise.all([
      db.project.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null, cityId: { in: cityIds }, status: { not: "CANCELLED" } },
        select: {
          id: true, name: true, status: true, eventDate: true, revenue: true, estCost: true, actCost: true,
          city: { select: { name: true } }, client: { select: { name: true } },
        },
        orderBy: { eventDate: "desc" },
      }),
      db.$queryRaw<Array<{ project_id: string; invoiced: number; billed: number; collected: number; receivable: number; invoices: number }>>(Prisma.sql`
        SELECT i.project_id,
               COALESCE(SUM(i.taxable_amount), 0)::float8 AS invoiced,
               COALESCE(SUM(i.total - COALESCE(c.amt, 0) + COALESCE(d.amt, 0)), 0)::float8 AS billed,
               COALESCE(SUM(COALESCE(p.amt, 0)), 0)::float8 AS collected,
               COALESCE(SUM(GREATEST(i.total - COALESCE(c.amt, 0) + COALESCE(d.amt, 0) - COALESCE(p.amt, 0), 0))
                        FILTER (WHERE i.status::text IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')), 0)::float8 AS receivable,
               COUNT(*)::int AS invoices
          FROM invoices i
          LEFT JOIN (SELECT invoice_id, SUM(amount) AS amt FROM payments GROUP BY 1) p ON p.invoice_id = i.id
          LEFT JOIN (SELECT invoice_id, SUM(amount) AS amt FROM credit_notes GROUP BY 1) c ON c.invoice_id = i.id
          LEFT JOIN (SELECT invoice_id, SUM(amount) AS amt FROM debit_notes GROUP BY 1) d ON d.invoice_id = i.id
         WHERE i.workspace_id = ${user.workspaceId}::uuid
           AND i.deleted_at IS NULL
           AND i.doc_type::text = 'TAX_INVOICE'
           AND i.status::text IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE')
           AND i.city_id = ANY(${cityIds}::uuid[])
         GROUP BY i.project_id`),
      db.expense.groupBy({
        by: ["projectId"],
        where: { deletedAt: null, status: { in: [...COST_STATES] }, project: { workspaceId: user.workspaceId, cityId: { in: cityIds } } },
        _sum: { amount: true },
      }),
      db.$queryRaw<Array<{ project_id: string; received: number; committed: number }>>(Prisma.sql`
        SELECT pr.project_id,
               COALESCE(SUM(po.total) FILTER (WHERE po.status::text IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')), 0)::float8 AS received,
               COALESCE(SUM(po.total) FILTER (WHERE po.status::text = 'SENT'), 0)::float8 AS committed
          FROM purchase_orders po
          JOIN purchase_requests pr ON pr.id = po.pr_id
         WHERE po.deleted_at IS NULL AND pr.project_id IS NOT NULL AND pr.city_id = ANY(${cityIds}::uuid[])
         GROUP BY pr.project_id`),
    ]);

    const moneyBy = new Map(money.map((m) => [m.project_id, m]));
    const expenseBy = new Map(expenses.map((e) => [e.projectId, e._sum.amount?.toNumber() ?? 0]));
    const orderBy = new Map(orders.map((o) => [o.project_id, o]));

    const rows = projects.map((p) => {
      const m = moneyBy.get(p.id);
      const o = orderBy.get(p.id);
      const booked = p.revenue.toNumber();
      const invoiced = m ? Number(m.invoiced) : 0;
      const cost = round2((expenseBy.get(p.id) ?? 0) + (o ? Number(o.received) : 0) + p.actCost.toNumber());
      // Margin is measured on what has been invoiced once invoicing starts;
      // before that, on the booked value — and never on nothing.
      const base = invoiced > 0 ? invoiced : booked;
      return {
        id: p.id,
        name: p.name,
        client: p.client.name,
        city: p.city.name,
        status: p.status,
        eventDate: p.eventDate,
        booked,
        budget: p.estCost.toNumber(),
        invoiced,
        collected: m ? round2(Number(m.collected)) : 0,
        receivable: m ? round2(Number(m.receivable)) : 0,
        invoices: m ? Number(m.invoices) : 0,
        cost,
        committed: o ? round2(Number(o.committed)) : 0,
        profit: round2(base - cost),
        marginPct: base > 0 ? round2(((base - cost) / base) * 100) : null,
      };
    });
    const withMoney = rows.filter((r) => r.booked || r.invoiced || r.cost || r.committed || r.budget);
    const totals = {
      booked: round2(sum(rows.map((r) => r.booked))),
      invoiced: round2(sum(rows.map((r) => r.invoiced))),
      collected: round2(sum(rows.map((r) => r.collected))),
      receivable: round2(sum(rows.map((r) => r.receivable))),
      cost: round2(sum(rows.map((r) => r.cost))),
      committed: round2(sum(rows.map((r) => r.committed))),
    };
    const base = totals.invoiced > 0 ? totals.invoiced : totals.booked;
    return {
      totals: { ...totals, profit: round2(base - totals.cost), marginPct: base > 0 ? round2(((base - totals.cost) / base) * 100) : null },
      // Every project, so figures can be entered for those with none yet;
      // the screen shows the ones with money by default.
      projects: rows.map((r) => ({ ...r, hasMoney: withMoney.includes(r) })),
      projectsWithMoney: withMoney.length,
    };
  }

  /**
   * Cash flow: money actually received against money actually paid out, by
   * month. Built from payments and expenses only — never from invoice totals,
   * which are entitlements, not cash.
   */
  async cashFlow(user: RequestUser, from?: string, to?: string, cityId?: string) {
    const { start, end } = this.range(from, to);
    const cityIds = await this.visibleCityIds(user, cityId);

    const inflows = await this.prisma.client.$queryRaw<Array<{ month: Date; amount: string }>>(Prisma.sql`
      SELECT date_trunc('month', p.received_at) AS month, COALESCE(SUM(p.amount), 0)::text AS amount
        FROM payments p
        JOIN invoices i ON i.id = p.invoice_id
       WHERE i.workspace_id = ${user.workspaceId}::uuid
         AND i.deleted_at IS NULL
         AND i.city_id = ANY(${cityIds}::uuid[])
         AND p.received_at BETWEEN ${start} AND ${end}
       GROUP BY 1 ORDER BY 1`);

    const outflows = await this.prisma.client.$queryRaw<Array<{ month: Date; amount: string }>>(Prisma.sql`
      SELECT date_trunc('month', e.incurred_at) AS month, COALESCE(SUM(e.amount), 0)::text AS amount
        FROM expenses e
        JOIN projects pr ON pr.id = e.project_id
       WHERE pr.workspace_id = ${user.workspaceId}::uuid
         AND e.deleted_at IS NULL
         AND e.status IN ('APPROVED', 'REIMBURSED')
         AND pr.city_id = ANY(${cityIds}::uuid[])
         AND e.incurred_at BETWEEN ${start} AND ${end}
       GROUP BY 1 ORDER BY 1`);

    const months = new Map<string, { month: string; inflow: number; outflow: number; net: number }>();
    const touch = (m: Date) => {
      const key = m.toISOString().slice(0, 7);
      if (!months.has(key)) months.set(key, { month: key, inflow: 0, outflow: 0, net: 0 });
      return months.get(key)!;
    };
    for (const r of inflows) touch(r.month).inflow = Number(r.amount);
    for (const r of outflows) touch(r.month).outflow = Number(r.amount);
    const series = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
    for (const m of series) m.net = round2(m.inflow - m.outflow);

    const hasData = series.length > 0;
    return {
      kind: "actuals" as const,
      from: start.toISOString(),
      to: end.toISOString(),
      hasData,
      explanation: hasData ? null : "No payments or approved expenses exist in this range.",
      series,
      totals: {
        inflow: round2(sum(series.map((m) => m.inflow))),
        outflow: round2(sum(series.map((m) => m.outflow))),
        net: round2(sum(series.map((m) => m.net))),
      },
    };
  }

  /**
   * Forecast — a MODEL OUTPUT, never mixed with actuals.
   *
   * The prototype's PNL_CFG applies a monthly seasonality index to a baseline.
   * That is only meaningful with a real baseline to scale, so this refuses to
   * emit numbers when there are no actuals: a seasonality curve applied to an
   * invented baseline would be indistinguishable from a real projection, which
   * is precisely the fabrication this build refuses to produce.
   */
  async forecast(user: RequestUser, opts: { cityId?: string; months?: number; baseline?: number }) {
    const months = Math.min(Math.max(opts.months ?? 12, 1), 24);
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
    const actuals = await this.pnl(user, {
      scope: opts.cityId ? "city" : "company",
      cityId: opts.cityId,
      from: yearStart.toISOString(),
      to: now.toISOString(),
    });

    // An explicit caller-supplied baseline is a stated assumption and is
    // allowed; a baseline the system invents for itself is not.
    const monthlyBaseline = opts.baseline ?? (actuals.hasData ? actuals.revenue.netRevenue / 12 : null);

    if (monthlyBaseline === null) {
      return {
        kind: "forecast" as const,
        basis: "none" as const,
        hasData: false,
        explanation:
          "No forecast can be produced: there is no real revenue history to anchor a baseline on, and this build " +
          "will not invent one. Supply an explicit `baseline` (a stated monthly revenue assumption) to model from, " +
          "or wait until real invoices exist.",
        series: [],
      };
    }

    // Blueprint §18's seasonality shape: Indian wedding/event season peaks
    // Nov-Feb, troughs through the monsoon.
    const SEASONALITY = [1.25, 1.15, 0.95, 0.8, 0.7, 0.6, 0.55, 0.6, 0.85, 1.1, 1.35, 1.4];
    const series = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
      const index = SEASONALITY[d.getUTCMonth()];
      return {
        month: d.toISOString().slice(0, 7),
        seasonalityIndex: index,
        projectedNetRevenue: round2(monthlyBaseline * index),
      };
    });

    return {
      kind: "forecast" as const,
      basis: opts.baseline !== undefined ? ("caller_supplied_baseline" as const) : ("trailing_12_month_actuals" as const),
      hasData: true,
      monthlyBaseline: round2(monthlyBaseline),
      explanation:
        "Projection only. These figures are a seasonality model applied to a baseline — they are NOT actuals and " +
        "must never be added to, or displayed in the same total as, an actuals figure.",
      series,
    };
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
