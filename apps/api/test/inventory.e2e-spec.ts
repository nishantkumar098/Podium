import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * The ledger's whole reason to exist (blueprint §14) is that concurrent
 * stock movements on the same SKU/location can never oversell or produce a
 * negative balance — the direct fix for the prototype's unguarded
 * `qty[cityIdx] -= n`. This fires a burst of concurrent CONSUME requests
 * whose combined quantity exceeds on-hand stock and asserts the ledger
 * never goes negative and the final balance is exactly what the *accepted*
 * movements justify.
 */
describe("Inventory ledger concurrency (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    // Needs multi-city access since this spec moves stock across Goa/Jaipur/Delhi stores —
    // Kritika Bansal (Admin) holds the workspace's ALL-city grant, same as Founder.
    token = await loginAs(app, "kritika.bansal@ammbrands.in");
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Creates its own stock rather than consuming the fixture's.
   *
   * This test used to read the seeded Goa quantity of SP-CAM and consume it to
   * zero, which made it pass on a freshly seeded database and fail on a second
   * consecutive run — the suite was only green because CI seeds first. It now
   * receives a known quantity through the real ledger and consumes exactly
   * that, so it is idempotent and can run any number of times.
   */
  it("never lets concurrent CONSUME movements take on-hand stock negative", async () => {
    const location = await prisma.inventoryLocation.findFirstOrThrow({ where: { name: "Goa Store" } });
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: "SP-CAM" } });

    // Bring the balance to a known 2 via real RECEIVE/CONSUME movements — never
    // by writing inventory_balances directly, which is the rule this whole
    // module exists to enforce.
    const current = await prisma.inventoryBalance.findFirst({ where: { skuId: item.id, locationId: location.id } });
    const delta = 2 - (current?.qtyOnHand ?? 0);
    if (delta !== 0) {
      const res = await request(app.getHttpServer())
        .post("/api/inventory/movements")
        .set("Authorization", `Bearer ${token}`)
        .send(
          delta > 0
            ? { skuId: item.id, type: "RECEIVE", toLocationId: location.id, qty: delta, note: "test setup" }
            : { skuId: item.id, type: "CONSUME", fromLocationId: location.id, qty: -delta, note: "test setup" },
        );
      expect(res.status).toBe(201);
    }

    const before = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: location.id } });
    expect(before.qtyOnHand).toBe(2);

    // Fire 5 concurrent consumes of 1 unit each against a balance that can only satisfy `before.qtyOnHand` of them.
    const attempts = Array.from({ length: 5 }, () =>
      request(app.getHttpServer())
        .post("/api/inventory/movements")
        .set("Authorization", `Bearer ${token}`)
        .send({ skuId: item.id, type: "CONSUME", fromLocationId: location.id, qty: 1, note: "concurrency test" }),
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 400).length;
    expect(succeeded).toBe(before.qtyOnHand);
    expect(succeeded + rejected).toBe(5);

    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: location.id } });
    expect(after.qtyOnHand).toBe(0);
    expect(after.qtyOnHand).toBeGreaterThanOrEqual(0);
  });

  /**
   * Regression test for a real bug a production-readiness audit found: every
   * test in this file (deliberately, for the concurrency test's multi-city
   * needs) ran as an ALL-city-scope Admin/Founder user, which meant
   * GET /inventory/balances's city-scope-filtered code path was never
   * exercised. A city-scoped (non-ALL) caller hit a 500 — the scope filter
   * was nested one level too deep (`location.city.cityId` instead of
   * `location.cityId`; City's own key is `id`, not `cityId`). Fixed in
   * InventoryService.listBalances; this test pins it down so a future
   * refactor of the scope-filter shape can't silently reintroduce it.
   */
  it("a city-scoped (non-ALL) user can list balances, restricted to their own city", async () => {
    // Devansh Jain: Operations role, city access = Jaipur only (not ALL).
    const scopedToken = await loginAs(app, "devansh.jain@ammbrands.in");
    const res = await request(app.getHttpServer())
      .get("/api/inventory/balances")
      .set("Authorization", `Bearer ${scopedToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    const cities = new Set(res.body.map((b: { location: { city: { name: string } } }) => b.location.city.name));
    expect([...cities]).toEqual(["Jaipur"]);
  });

  /**
   * Phase H.1 (self-correcting sub-phase): this test used to read the
   * seeded Jaipur balance and transfer 3 units out of it directly — it
   * passed on a freshly seeded database but drained the source balance by 3
   * on every subsequent run, until a run found less than 3 units left and
   * got a real 400 "insufficient stock" instead of the expected 201. Fixed
   * with the same known-quantity setup already used above for the CONSUME
   * test: bring the source balance to a fixed quantity through the real
   * ledger first, so the test is idempotent and re-runnable any number of
   * times.
   */
  it("a transfer moves stock atomically between two locations", async () => {
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: "SP-VOD-AB" } });
    const from = await prisma.inventoryLocation.findFirstOrThrow({ where: { name: "Jaipur Store" } });
    const to = await prisma.inventoryLocation.findFirstOrThrow({ where: { name: "Delhi Store" } });

    const KNOWN_FROM_QTY = 10;
    const currentFrom = await prisma.inventoryBalance.findFirst({ where: { skuId: item.id, locationId: from.id } });
    const delta = KNOWN_FROM_QTY - (currentFrom?.qtyOnHand ?? 0);
    if (delta !== 0) {
      const setupRes = await request(app.getHttpServer())
        .post("/api/inventory/movements")
        .set("Authorization", `Bearer ${token}`)
        .send(
          delta > 0
            ? { skuId: item.id, type: "RECEIVE", toLocationId: from.id, qty: delta, note: "test setup" }
            : { skuId: item.id, type: "CONSUME", fromLocationId: from.id, qty: -delta, note: "test setup" },
        );
      expect(setupRes.status).toBe(201);
    }

    const beforeFrom = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: from.id } });
    const beforeTo = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: to.id } });
    expect(beforeFrom.qtyOnHand).toBe(KNOWN_FROM_QTY);

    await request(app.getHttpServer())
      .post("/api/inventory/movements")
      .set("Authorization", `Bearer ${token}`)
      .send({ skuId: item.id, type: "TRANSFER_OUT", fromLocationId: from.id, toLocationId: to.id, qty: 3 })
      .expect(201);

    const afterFrom = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: from.id } });
    const afterTo = await prisma.inventoryBalance.findFirstOrThrow({ where: { skuId: item.id, locationId: to.id } });
    expect(afterFrom.qtyOnHand).toBe(beforeFrom.qtyOnHand - 3);
    expect(afterTo.qtyOnHand).toBe(beforeTo.qtyOnHand + 3);
  });
});
