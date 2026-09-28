import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase F.5: the CRM/Pipeline frontend needed a lead-detail endpoint that
 * never existed before (only list, stage-change, mark-won and convert did)
 * — added GET /leads/:id following the exact same permission + city-scope
 * pattern as ClientsService.get(). Also covers GET /users (Phase F.5's new
 * bare user list, needed for the conversion form's PM picker), since it was
 * added in this same phase and had no test coverage yet.
 */
describe("Lead detail + user list (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let sales: string; // Ananya Joshi — Sales, WRITE scope on Delhi only
  let opsJaipur: string; // Devansh Jain — Operations, no "leads" resource at all

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    sales = await loginAs(app, "ananya.joshi@ammbrands.in");
    opsJaipur = await loginAs(app, "devansh.jain@ammbrands.in");
  });

  afterAll(async () => await app.close());

  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);
  const post = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});

  describe("GET /leads/:id", () => {
    it("returns a lead's full detail for a caller with access", async () => {
      const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });
      const created = await post("/api/leads", founder, {
        name: "e2e detail — Jaipur lead",
        value: 300000,
        cityId: jaipur.id,
        ownerId: (await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } })).id,
      });
      expect(created.status).toBe(201);

      const res = await get(`/api/leads/${created.body.id}`, founder);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.name).toBe("e2e detail — Jaipur lead");
      expect(res.body.stage).toBe("LEAD");
    });

    it("404s for a lead that doesn't exist", async () => {
      const res = await get("/api/leads/00000000-0000-0000-0000-000000000000", founder);
      expect(res.status).toBe(404);
    });

    it("RBAC: a role with no leads resource at all is blocked", async () => {
      const lead = await prisma.lead.findFirstOrThrow({ where: { kind: "PIPELINE" } });
      expect((await get(`/api/leads/${lead.id}`, opsJaipur)).status).toBe(403);
      expect((await get("/api/leads", opsJaipur)).status).toBe(403);
    });

    it("city-scope: a WRITE-scoped Sales user cannot open a lead outside their city", async () => {
      const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });
      const jaipurLead = await prisma.lead.findFirstOrThrow({ where: { kind: "PIPELINE", cityId: jaipur.id } });
      const res = await get(`/api/leads/${jaipurLead.id}`, sales);
      expect(res.status).toBe(403);
    });

    it("city-scope: the same Sales user can open a lead in their own city (Delhi)", async () => {
      const delhi = await prisma.city.findFirstOrThrow({ where: { code: "DEL" } });
      const ownerId = (await prisma.user.findFirstOrThrow({ where: { email: "ananya.joshi@ammbrands.in" } })).id;
      const created = await post("/api/leads", founder, {
        name: "e2e detail — Delhi lead",
        value: 200000,
        cityId: delhi.id,
        ownerId,
      });
      expect(created.status).toBe(201);
      const res = await get(`/api/leads/${created.body.id}`, sales);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /users", () => {
    it("Superadmin (people:view via full CRUD) gets a non-empty active-user list", async () => {
      const res = await get("/api/users", founder);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const anant = res.body.find((u: { email: string }) => u.email === "anant.sharma@ammbrands.in");
      expect(anant).toBeDefined();
      // The fixture that can do anything is Superadmin; Founder is the
      // read-only role (see apps/api/src/common/rbac/model.ts).
      expect(anant.roles).toContain("Superadmin");
      expect(anant.name).toBe("Anant Sharma");
    });

    it("RBAC: Sales has no people:view and is blocked", async () => {
      expect((await get("/api/users", sales)).status).toBe(403);
    });
  });
});
