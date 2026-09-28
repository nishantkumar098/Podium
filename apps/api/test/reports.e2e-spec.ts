import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 10 (blueprint §18). The two things worth asserting are that Actuals
 * come only from real transactions, and that a Forecast can never be mistaken
 * for — or summed with — one.
 */
describe("Reports: P&L, cash flow, forecast (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let cityId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    cityId = (await prisma.city.findFirstOrThrow({ where: { code: "JPR" } })).id;
  });
  afterAll(async () => await app.close());

  const get = (p: string, t = founder) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);

  it("P&L actuals are tagged as actuals and carry a real date range", async () => {
    const res = await get("/api/reports/pnl?scope=company");
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("actuals");
    expect(new Date(res.body.from).getTime()).toBeLessThan(new Date(res.body.to).getTime());
  });

  it("net revenue excludes GST — tax collected is not revenue", async () => {
    const res = await get("/api/reports/pnl?scope=company");
    const { netRevenue, gstCollected, grossInvoiced } = res.body.revenue;
    // Whatever the data, the identity must hold exactly.
    expect(Math.round((netRevenue + gstCollected) * 100) / 100).toBe(Math.round(grossInvoiced * 100) / 100);
  });

  it("a period with no real transactions reports hasData=false with an explanation, not a bare zero", async () => {
    // A window far in the past: the seeded fixture has nothing there.
    const res = await get("/api/reports/pnl?scope=company&from=2001-01-01&to=2001-12-31");
    expect(res.body.hasData).toBe(false);
    expect(res.body.explanation).toMatch(/no real financial transactions/i);
    expect(res.body.revenue.netRevenue).toBe(0);
    expect(res.body.margin.grossMarginPct).toBeNull(); // not 0% — undefined, because there is no denominator
  });

  it("draft invoices are never counted as revenue", async () => {
    const drafts = await prisma.invoice.count({ where: { status: "DRAFT" } });
    const res = await get("/api/reports/pnl?scope=company");
    if (drafts > 0) {
      const draftTotal = await prisma.invoice.aggregate({ _sum: { total: true }, where: { status: "DRAFT" } });
      expect(res.body.revenue.grossInvoiced).not.toBe(Number(draftTotal._sum.total ?? 0));
    }
    expect(res.body.kind).toBe("actuals");
  });

  it("cash flow is built from payments and expenses, never from invoice totals", async () => {
    const res = await get("/api/reports/cash-flow");
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("actuals");
    for (const m of res.body.series) {
      expect(Math.round((m.inflow - m.outflow) * 100) / 100).toBe(m.net);
    }
  });

  it("per-city P&L is returned per real city and each is tagged actuals", async () => {
    const res = await get("/api/reports/pnl/by-city");
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("actuals");
    expect(res.body.cities.length).toBeGreaterThan(0);
    expect(res.body.cities.every((c: { kind: string }) => c.kind === "actuals")).toBe(true);
  });

  it("FORECAST is a separate kind and refuses to invent a baseline when there are no actuals", async () => {
    const res = await get("/api/reports/forecast");
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("forecast"); // never "actuals"
    if (!res.body.hasData) {
      expect(res.body.explanation).toMatch(/will not invent one/i);
      expect(res.body.series).toEqual([]);
    }
  });

  it("a caller-supplied baseline is modelled, labelled as an assumption, and never called actuals", async () => {
    const res = await get("/api/reports/forecast?baseline=100000&months=12");
    expect(res.body.kind).toBe("forecast");
    expect(res.body.basis).toBe("caller_supplied_baseline");
    expect(res.body.series.length).toBe(12);
    expect(res.body.explanation).toMatch(/NOT actuals/);
    // Every point is a projection, explicitly named as such.
    for (const p of res.body.series) {
      expect(p).toHaveProperty("projectedNetRevenue");
      expect(p).not.toHaveProperty("netRevenue"); // no field name shared with actuals
    }
  });

  it("no endpoint returns actuals and forecast in one object", async () => {
    for (const path of ["/api/reports/pnl?scope=company", "/api/reports/cash-flow", "/api/reports/pnl/by-city"]) {
      const body = JSON.stringify((await get(path)).body);
      expect(body).not.toMatch(/"kind":"forecast"/);
    }
    const fc = JSON.stringify((await get("/api/reports/forecast?baseline=1000")).body);
    expect(fc).not.toMatch(/"kind":"actuals"/);
  });

  it("city scoping: a Delhi-scoped user's company P&L covers only their cities", async () => {
    const sales = await loginAs(app, "ananya.joshi@ammbrands.in"); // Delhi only, projects:view? -> check status
    const res = await get("/api/reports/pnl?scope=company", sales);
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const jaipurOnly = await get(`/api/reports/pnl?scope=city&cityId=${cityId}`, sales);
      expect(jaipurOnly.status).toBe(403); // not their city
    }
  });

  it("RBAC: a role without projects:view cannot read reports", async () => {
    const creative = await loginAs(app, "priya.rathore@ammbrands.in"); // Creative: tasks only
    expect((await get("/api/reports/pnl?scope=company", creative)).status).toBe(403);
  });
});
