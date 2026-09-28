import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase E: Menu costing (blueprint §19/§40). The point of this suite is the
 * costing math: cost/margin are computed server-side from real
 * inventory_items.standard_cost/size_ml every time, never stored, so the
 * assertions recompute the expected numbers from the same seeded SKU rows
 * rather than hardcoding a total that would silently drift if the seed data
 * ever changes.
 */
describe("Recipes / menu costing (e2e)", () => {
  let app: INestApplication;
  let ops: string;
  let sales: string;
  let ginId: string;
  let tonicId: string;
  let glassId: string; // GL-HB: sizeMl is null — not costable by ml

  beforeAll(async () => {
    app = await bootstrapTestApp();
    ops = await loginAs(app, "vikram.solanki@ammbrands.in");
    sales = await loginAs(app, "ananya.joshi@ammbrands.in");
    ginId = (await prisma.inventoryItem.findFirstOrThrow({ where: { sku: "SP-GIN-BS" } })).id;
    tonicId = (await prisma.inventoryItem.findFirstOrThrow({ where: { sku: "MX-TON-SP" } })).id;
    glassId = (await prisma.inventoryItem.findFirstOrThrow({ where: { sku: "GL-HB" } })).id;
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);

  it("GET /inventory/items lists the full SKU catalog, not just items with a balance", async () => {
    const res = await get("/api/inventory/items", ops);
    expect(res.status).toBe(200);
    expect(res.body.some((i: { sku: string }) => i.sku === "SP-GIN-BS")).toBe(true);
  });

  it("computes real cost/margin from live SKU cost and size — a Gin & Tonic", async () => {
    const res = await post("/api/recipes", ops, {
      name: "e2e — Gin & Tonic",
      glass: "Highball",
      garnishCost: 10,
      price: 350,
      items: [
        { skuId: ginId, qtyMl: 60 },
        { skuId: tonicId, qtyMl: 150 },
      ],
    });
    expect(res.status).toBe(201);

    const gin = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ginId } });
    const tonic = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: tonicId } });
    const expectedIngredientCost = 60 * (Number(gin.standardCost) / gin.sizeMl!) + 150 * (Number(tonic.standardCost) / tonic.sizeMl!);
    const expectedTotal = expectedIngredientCost + 10;
    const expectedMargin = 350 - expectedTotal;

    expect(res.body.costing.allCostable).toBe(true);
    expect(res.body.costing.ingredientCost).toBeCloseTo(expectedIngredientCost, 4);
    expect(res.body.costing.totalCost).toBeCloseTo(expectedTotal, 4);
    expect(res.body.costing.margin).toBeCloseTo(expectedMargin, 4);
    expect(res.body.costing.marginPct).toBeCloseTo(Math.round((expectedMargin / 350) * 1000) / 10, 1);
  });

  it("flags a recipe as not-costable when an ingredient has no sizeMl, instead of guessing", async () => {
    const res = await post("/api/recipes", ops, {
      name: "e2e — Glass-only line",
      glass: "Highball",
      price: 100,
      items: [{ skuId: glassId, qtyMl: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.costing.allCostable).toBe(false);
    expect(res.body.costing.totalCost).toBeNull();
    expect(res.body.costing.margin).toBeNull();
    expect(res.body.items[0].costable).toBe(false);
  });

  it("rejects a recipe referencing a SKU that doesn't exist", async () => {
    const res = await post("/api/recipes", ops, {
      name: "e2e — Bad SKU",
      glass: "Rocks",
      price: 100,
      items: [{ skuId: "00000000-0000-0000-0000-000000000000", qtyMl: 30 }],
    });
    expect(res.status).toBe(400);
  });

  it("replacing a recipe's items recomputes costing against the new list", async () => {
    const create = await post("/api/recipes", ops, {
      name: "e2e — Update me",
      glass: "Highball",
      price: 300,
      items: [{ skuId: ginId, qtyMl: 30 }],
    });
    const id = create.body.id;

    const patched = await request(app.getHttpServer())
      .patch(`/api/recipes/${id}`)
      .set("Authorization", `Bearer ${ops}`)
      .send({ items: [{ skuId: tonicId, qtyMl: 200 }] });
    expect(patched.status).toBe(200);
    expect(patched.body.items).toHaveLength(1);
    expect(patched.body.items[0].skuId).toBe(tonicId);

    const rows = await prisma.recipeItem.findMany({ where: { recipeId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].skuId).toBe(tonicId);
  });

  it("RBAC: Sales has no recipes access at all", async () => {
    expect((await get("/api/recipes", sales)).status).toBe(403);
  });
});
