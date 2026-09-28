import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * The 2026-09-11 real-data import made `cityId` nullable on clients, vendors,
 * freelancers and leads, because most of AMM's real records carry no city and
 * inventing one would drive GST treatment and city scoping from a fabricated
 * value (see docs/STATUS.md §0.0).
 *
 * That created a genuinely new access-control case the original suite had no
 * reason to cover: a row belonging to *no* city. The rule is that an
 * unassigned row is reachable only by an ALL-scope caller — the stricter
 * reading, hiding rows rather than exposing them. This has to hold identically
 * in list and detail views, or a city-scoped user could be denied a row on one
 * screen and shown it on another.
 */
describe("City scoping with an unassigned (NULL) city (e2e)", () => {
  let app: INestApplication;
  let founderToken: string;
  let salesToken: string;
  let workspaceId: string;
  let noCityClientId: string;
  let jaipurClientId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founderToken = await loginAs(app, "anant.sharma@ammbrands.in"); // ALL-city grant
    salesToken = await loginAs(app, "ananya.joshi@ammbrands.in"); // Delhi-scoped, holds leads:view/clients:view

    const workspace = await prisma.workspace.findFirstOrThrow();
    workspaceId = workspace.id;
    const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });

    const noCity = await prisma.client.create({
      data: { workspaceId, name: "ZZ Unassigned-city import row", type: "INDIVIDUAL", cityId: null, phone: "9000000001", segment: "EVENT_CLIENT", source: "test fixture" },
    });
    noCityClientId = noCity.id;
    const jpr = await prisma.client.create({
      data: { workspaceId, name: "ZZ Jaipur import row", type: "INDIVIDUAL", cityId: jaipur.id, phone: "9000000002", segment: "EVENT_CLIENT", source: "test fixture" },
    });
    jaipurClientId = jpr.id;
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: [noCityClientId, jaipurClientId] } } });
    await app.close();
  });

  function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
  }

  it("a city-scoped user does NOT see unassigned-city rows in the list", async () => {
    const res = await get("/api/clients?limit=500", salesToken);
    expect(res.status).toBe(200);
    const ids = res.body.rows.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(noCityClientId);
    expect(ids).not.toContain(jaipurClientId); // different city — also hidden
  });

  it("a city-scoped user is 403'd opening an unassigned-city row directly", async () => {
    // List and detail must agree: a row hidden from the list must not be
    // openable by guessing its id.
    const res = await get(`/api/clients/${noCityClientId}`, salesToken);
    expect(res.status).toBe(403);
  });

  it("an ALL-scope user sees unassigned-city rows in the list", async () => {
    const res = await get("/api/clients?limit=500", founderToken);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((c: { id: string }) => c.id)).toContain(noCityClientId);
  });

  it("an ALL-scope user can open an unassigned-city row", async () => {
    const res = await get(`/api/clients/${noCityClientId}`, founderToken);
    expect(res.status).toBe(200);
    expect(res.body.cityId).toBeNull();
  });

  it("the clients list is paged and defaults to the EVENT_CLIENT segment", async () => {
    // The retail dump is ~90x the size of the real B2B list; it must never be
    // the default, and the list must never ship unbounded.
    const retail = await prisma.client.create({
      data: { workspaceId, name: "ZZ Retail row", type: "INDIVIDUAL", cityId: null, phone: "9000000003", segment: "RETAIL_CUSTOMER", source: "test fixture" },
    });
    try {
      const def = await get("/api/clients?limit=500", founderToken);
      expect(def.body.rows.every((c: { segment: string }) => c.segment === "EVENT_CLIENT")).toBe(true);
      expect(def.body.rows.map((c: { id: string }) => c.id)).not.toContain(retail.id);

      const explicit = await get("/api/clients?segment=RETAIL_CUSTOMER&limit=500", founderToken);
      expect(explicit.body.rows.map((c: { id: string }) => c.id)).toContain(retail.id);

      const paged = await get("/api/clients?limit=2", founderToken);
      expect(paged.body.rows.length).toBeLessThanOrEqual(2);
      expect(paged.body.total).toBeGreaterThan(2);
    } finally {
      await prisma.client.delete({ where: { id: retail.id } });
    }
  });
});
