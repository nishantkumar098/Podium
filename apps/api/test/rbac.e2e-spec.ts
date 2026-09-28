import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Permission tests generated loosely from the RBAC matrix (blueprint §11) —
 * not the full role x endpoint cross-product the blueprint calls for
 * eventually, but a real check per boundary this build actually enforces:
 * unauthenticated is rejected, a role without a grant is rejected, a role
 * with the grant succeeds. Extend this file as new endpoints land.
 */
describe("RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unauthenticated request", async () => {
    await request(app.getHttpServer()).get("/api/projects").expect(401);
  });

  it("rejects an invalid login", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "wrong-password" })
      .expect(401);
  });

  it("Sales role cannot read invoices (no invoices:view grant)", async () => {
    const token = await loginAs(app, "ananya.joshi@ammbrands.in"); // Sales Manager
    await request(app.getHttpServer())
      .get("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("Finance role can read invoices", async () => {
    const token = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance Manager
    const res = await request(app.getHttpServer()).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("Sales role can read leads (CRM is theirs)", async () => {
    const token = await loginAs(app, "ananya.joshi@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/leads").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Founder (all-city grant) can read every city", async () => {
    const token = await loginAs(app, "anant.sharma@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/cities").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(6);
  });

  // ------------------------------------------------- department boundaries
  //
  // The policy itself is proved in rbac-model.e2e-spec.ts, which needs no
  // database. These are the same rules seen from outside, over HTTP, on the
  // endpoints that used to leak.

  it("a Project Manager cannot open the company P&L", async () => {
    // It was gated on projects:view — which every PM holds.
    const token = await loginAs(app, "rohit.meena@ammbrands.in");
    await request(app.getHttpServer()).get("/api/reports/pnl").set("Authorization", `Bearer ${token}`).expect(403);
    await request(app.getHttpServer()).get("/api/reports/pnl/by-city").set("Authorization", `Bearer ${token}`).expect(403);
    await request(app.getHttpServer()).get("/api/reports/project-finance").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("Finance can open the company P&L", async () => {
    const token = await loginAs(app, "neha.agarwal@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/reports/pnl").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Operations cannot reach employee records", async () => {
    const token = await loginAs(app, "devansh.jain@ammbrands.in");
    await request(app.getHttpServer()).get("/api/people").set("Authorization", `Bearer ${token}`).expect(403);
    await request(app.getHttpServer()).get("/api/users").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("Admin can read an employee record but cannot change one", async () => {
    const token = await loginAs(app, "kritika.bansal@ammbrands.in");
    const list = await request(app.getHttpServer()).get("/api/people").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const someone = await request(app.getHttpServer()).get("/api/users").set("Authorization", `Bearer ${token}`);
    expect(someone.status).toBe(200);
    const target = someone.body[0] as { id: string };
    await request(app.getHttpServer())
      .put(`/api/people/attendance/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "PRESENT" })
      .expect(403);
  });

  it("Operations sees a vendor without its banking or balance", async () => {
    const token = await loginAs(app, "devansh.jain@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/vendors").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const v of res.body as Array<Record<string, unknown>>) {
      expect("bankAccountNo" in v).toBe(false);
      expect("openingBalance" in v).toBe(false);
      expect("openOrders" in v).toBe(false);
      expect(typeof v.name).toBe("string"); // …but still knows who the vendor is
    }
  });

  it("an event carries no revenue or cost for anyone without budgets:view", async () => {
    const token = await loginAs(app, "rohit.meena@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/projects").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const p of res.body as Array<Record<string, unknown>>) {
      expect("revenue" in p).toBe(false);
      expect("estCost" in p).toBe(false);
    }
  });

  it("a city-scoped user only sees their own city's projects", async () => {
    // Rohit Meena (u3) is scoped to Dehradun only.
    const token = await loginAs(app, "rohit.meena@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/projects").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const cityNames = new Set(res.body.map((p: { city: { name: string } }) => p.city.name));
    expect(cityNames.size).toBeGreaterThan(0);
    expect([...cityNames]).toEqual(["Dehradun"]);
  });
});
