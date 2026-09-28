import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 5 (blueprint §13): purchase_requests -> approval -> purchase_orders ->
 * goods_receipts -> inventory ledger.
 *
 * The reconciliation assertion at the end is the point of this suite: after a
 * partial receipt and then the remainder, on-hand stock must equal
 * SUM(inventory_movements) exactly, checked with a direct SQL aggregate rather
 * than through the application code that produced it.
 */
describe("Procurement PR -> PO -> GRN -> ledger (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let ops: string;
  let vendorId: string;
  let skuA: string;
  let skuB: string;
  let locationId: string;
  let cityId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in"); // inventory:approve
    ops = await loginAs(app, "vikram.solanki@ammbrands.in"); // Operations, Jaipur

    const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });
    cityId = jaipur.id;
    locationId = (await prisma.inventoryLocation.findFirstOrThrow({ where: { cityId: jaipur.id } })).id;
    vendorId = (await prisma.vendor.findFirstOrThrow({ where: { deletedAt: null } })).id;
    const skus = await prisma.inventoryItem.findMany({ where: { deletedAt: null }, take: 2 });
    skuA = skus[0].id;
    skuB = skus[1].id;
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown, key?: string) => {
    const r = request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`);
    if (key) r.set("idempotency-key", key);
    return r.send(b ?? {});
  };
  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);

  /** on-hand, straight from the ledger — not from inventory_balances. */
  async function ledgerQty(skuId: string, locId: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ qty: bigint | null }>>`
      SELECT COALESCE(SUM(CASE WHEN to_location_id = ${locId}::uuid THEN qty
                               WHEN from_location_id = ${locId}::uuid THEN -qty
                               ELSE 0 END), 0) AS qty
        FROM inventory_movements WHERE sku_id = ${skuId}::uuid`;
    return Number(rows[0]?.qty ?? 0);
  }
  async function balanceQty(skuId: string, locId: string): Promise<number> {
    const b = await prisma.inventoryBalance.findUnique({ where: { skuId_locationId: { skuId, locationId: locId } } });
    return b?.qtyOnHand ?? 0;
  }

  it("a below-threshold request needs no approval and can raise a PO immediately", async () => {
    const res = await post("/api/purchase-requests", ops, {
      item: "Bar consumables top-up", vendorId, amount: 5_000, cityId,
    });
    expect(res.status).toBe(201);
    expect(res.body.needsApproval).toBe(false);
    expect(res.body.status).toBe("QUOTE_COMPARISON");
  });

  it("an at-or-above-threshold request is gated: PO is refused until approved", async () => {
    const pr = (await post("/api/purchase-requests", ops, {
      item: "Glassware restock", vendorId, amount: 50_000, cityId,
    })).body;
    expect(pr.needsApproval).toBe(true);
    expect(pr.status).toBe("APPROVAL_PENDING");

    // A real PENDING approval row exists — the gate is data, not a UI flag.
    const approval = await prisma.approval.findFirstOrThrow({ where: { purchaseRequestId: pr.id } });
    expect(approval.status).toBe("PENDING");
    expect(approval.type).toBe("PURCHASE");

    const blocked = await post("/api/purchase-orders", ops, {
      prId: pr.id, items: [{ skuId: skuA, qtyOrdered: 10, unitPrice: 100 }],
    });
    expect(blocked.status).toBe(400);
    expect(await prisma.purchaseOrder.count({ where: { prId: pr.id } })).toBe(0);
  });

  /**
   * Separation of duties. Operations legitimately holds `inventory:approve`
   * (it approves stock adjustments), so the permission check ALONE would let
   * the person who raised a large purchase sign it off themselves. This was a
   * real hole found by running this test, not a hypothetical.
   */
  it("the requester cannot approve their own request, even holding inventory:approve", async () => {
    const pr = (await post("/api/purchase-requests", ops, { item: "Ice", vendorId, amount: 80_000, cityId })).body;

    const selfApproval = await post(`/api/purchase-requests/${pr.id}/decision`, ops, { approve: true });
    expect(selfApproval.status).toBe(403);
    expect((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("APPROVAL_PENDING");

    // Someone else with the permission can.
    expect((await post(`/api/purchase-requests/${pr.id}/decision`, founder, { approve: true })).status).toBe(201);
    expect((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("QUOTE_COMPARISON");
  });

  it("RBAC: a role without inventory:approve cannot decide at all", async () => {
    const salesToken = await loginAs(app, "ananya.joshi@ammbrands.in"); // Sales: no inventory:* grants
    const pr = (await post("/api/purchase-requests", ops, { item: "Sales cannot approve", vendorId, amount: 90_000, cityId })).body;
    expect((await post(`/api/purchase-requests/${pr.id}/decision`, salesToken, { approve: true })).status).toBe(403);
  });

  it("a rejected request can never raise a purchase order", async () => {
    const pr = (await post("/api/purchase-requests", ops, { item: "Rejected", vendorId, amount: 70_000, cityId })).body;
    await post(`/api/purchase-requests/${pr.id}/decision`, founder, { approve: false, reason: "Out of budget" });
    expect((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("REJECTED");
    const blocked = await post("/api/purchase-orders", ops, { prId: pr.id, items: [{ skuId: skuA, qtyOrdered: 1, unitPrice: 1 }] });
    expect(blocked.status).toBe(400);
  });

  /**
   * BUG-008 (Phase D.1). Found while building the Phase D procurement UI: PO
   * totals are computed server-side from real line items — never trusted from
   * the client — but were never checked against the amount the underlying
   * request was actually approved for. Approval clears at the REQUEST's own
   * estimated amount; nothing stopped the PO raised afterwards from being for
   * an arbitrarily larger sum once real vendor quotes came in.
   */
  it("BUG-008: a PO cannot exceed the amount its request was approved for", async () => {
    const pr = (await post("/api/purchase-requests", ops, { item: "Stage rigging", vendorId, amount: 80_000, cityId })).body;
    expect(pr.needsApproval).toBe(true);
    expect((await post(`/api/purchase-requests/${pr.id}/decision`, founder, { approve: true })).status).toBe(201);

    // 10 * 10,000 = 1,00,000 -- well over the 80,000 that was actually approved.
    const overBudget = await post("/api/purchase-orders", ops, {
      prId: pr.id,
      items: [{ skuId: skuA, qtyOrdered: 10, unitPrice: 10_000 }],
    });
    expect(overBudget.status).toBe(400);
    expect(overBudget.body.error.message).toMatch(/only approved for/i);
    expect(await prisma.purchaseOrder.count({ where: { prId: pr.id } })).toBe(0);

    // At or under the approved ceiling succeeds.
    const withinBudget = await post("/api/purchase-orders", ops, {
      prId: pr.id,
      items: [{ skuId: skuA, qtyOrdered: 8, unitPrice: 10_000 }],
    });
    expect(withinBudget.status).toBe(201);
    expect(Number(withinBudget.body.total)).toBe(80_000);
  });

  it("BUG-008 does not constrain a below-threshold request that never went through approval", async () => {
    // Quote comparison legitimately settling on a different figure than a
    // below-threshold request's original estimate is the normal path here --
    // no approval ceiling was ever granted to cap it against.
    const pr = (await post("/api/purchase-requests", ops, { item: "Small top-up", vendorId, amount: 5_000, cityId })).body;
    expect(pr.needsApproval).toBe(false);

    const po = await post("/api/purchase-orders", ops, {
      prId: pr.id,
      items: [{ skuId: skuA, qtyOrdered: 3, unitPrice: 10_000 }], // 30,000 -- well over the 5,000 estimate
    });
    expect(po.status).toBe(201);
    expect(Number(po.body.total)).toBe(30_000);
  });

  /**
   * BUG-010 (Phase D.2). Found while building the Phase D procurement frontend
   * against this endpoint: the Orders list view (and every other consumer of
   * GET /purchase-orders) shows each order's originating request, but
   * listOrders()'s Prisma include never selected `purchaseRequest` — only the
   * single-order getOrder() endpoint did. Every order in the list crashed the
   * frontend on `po.purchaseRequest.item` being undefined.
   */
  it("BUG-010: the purchase order list includes each order's originating request", async () => {
    const pr = (await post("/api/purchase-requests", ops, { item: "BUG-010 fixture item", vendorId, amount: 4_000, cityId })).body;
    const po = (await post("/api/purchase-orders", ops, {
      prId: pr.id,
      items: [{ skuId: skuA, qtyOrdered: 1, unitPrice: 4_000 }],
    })).body;

    const list = await get("/api/purchase-orders", ops);
    expect(list.status).toBe(200);
    const row = list.body.find((o: { id: string }) => o.id === po.id);
    expect(row).toBeDefined();
    expect(row.purchaseRequest).toBeDefined();
    expect(row.purchaseRequest.item).toBe("BUG-010 fixture item");
  });

  it("drives the full chain and reconciles the ledger exactly after a partial receipt", async () => {
    const beforeA = await balanceQty(skuA, locationId);
    const beforeB = await balanceQty(skuB, locationId);
    const beforeLedgerA = await ledgerQty(skuA, locationId);

    // PR -> approval -> PO
    const pr = (await post("/api/purchase-requests", ops, { item: "Full chain", vendorId, amount: 60_000, cityId })).body;
    expect(pr.needsApproval).toBe(true);
    expect((await post(`/api/purchase-requests/${pr.id}/decision`, founder, { approve: true })).status).toBe(201);

    const po = (await post("/api/purchase-orders", ops, {
      prId: pr.id,
      items: [
        { skuId: skuA, qtyOrdered: 10, unitPrice: 500 },
        { skuId: skuB, qtyOrdered: 4, unitPrice: 2_500 },
      ],
    })).body;
    // Total is computed server-side: 10*500 + 4*2500 = 15,000
    expect(Number(po.total)).toBe(15_000);
    expect(po.status).toBe("DRAFT");

    // Cannot receive against a DRAFT order.
    expect((await post(`/api/purchase-orders/${po.id}/receipts`, ops, {
      locationId, lines: [{ skuId: skuA, qty: 1 }],
    })).status).toBe(400);

    expect((await post(`/api/purchase-orders/${po.id}/send`, ops)).status).toBe(201);

    // --- partial receipt: 4 of 10 of A, none of B
    const partial = await post(`/api/purchase-orders/${po.id}/receipts`, ops, {
      locationId, lines: [{ skuId: skuA, qty: 4 }],
    });
    expect(partial.status).toBe(201);
    expect(partial.body.poStatus).toBe("PARTIALLY_RECEIVED");

    expect(await balanceQty(skuA, locationId)).toBe(beforeA + 4);
    expect(await ledgerQty(skuA, locationId)).toBe(beforeLedgerA + 4);

    // Over-receiving the remainder is rejected against what is outstanding.
    const over = await post(`/api/purchase-orders/${po.id}/receipts`, ops, {
      locationId, lines: [{ skuId: skuA, qty: 7 }], // only 6 left
    });
    expect(over.status).toBe(400);

    // --- remainder: 6 of A, 4 of B -> fully received
    const rest = await post(`/api/purchase-orders/${po.id}/receipts`, ops, {
      locationId, lines: [{ skuId: skuA, qty: 6 }, { skuId: skuB, qty: 4 }],
    });
    expect(rest.status).toBe(201);
    expect(rest.body.poStatus).toBe("RECEIVED");

    const finalPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(finalPo.status).toBe("RECEIVED");
    expect((await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("GOODS_RECEIVED");

    // --- the assertion that matters: balances reconcile to the ledger
    expect(await balanceQty(skuA, locationId)).toBe(beforeA + 10);
    expect(await balanceQty(skuB, locationId)).toBe(beforeB + 4);
    expect(await ledgerQty(skuA, locationId)).toBe(beforeLedgerA + 10);

    // Every received line produced a real RECEIVE movement referencing its GRN.
    const receipts = await prisma.goodsReceipt.findMany({ where: { poId: po.id } });
    expect(receipts.length).toBe(2);
    for (const r of receipts) {
      const movements = await prisma.inventoryMovement.findMany({ where: { refType: "goods_receipt", refId: r.id } });
      expect(movements.length).toBe(Object.keys(r.receivedQty as object).length);
      expect(movements.every((m) => m.type === "RECEIVE")).toBe(true);
    }

    // A closed order accepts nothing further.
    expect((await post(`/api/purchase-orders/${po.id}/close`, ops, {})).status).toBe(201);
    expect((await post(`/api/purchase-orders/${po.id}/receipts`, ops, {
      locationId, lines: [{ skuId: skuA, qty: 1 }],
    })).status).toBe(400);
  });

  it("every mutation wrote an audit_logs row", async () => {
    for (const action of [
      "purchase_request.create", "purchase_request.approved",
      "purchase_order.create", "purchase_order.sent", "goods_receipt.create",
    ]) {
      expect(await prisma.auditLog.count({ where: { action } })).toBeGreaterThan(0);
    }
  });

  it("idempotency: replaying a PO create with the same key does not raise a second order", async () => {
    const pr = (await post("/api/purchase-requests", ops, { item: "Idem", vendorId, amount: 1_000, cityId })).body;
    const body = { prId: pr.id, items: [{ skuId: skuA, qtyOrdered: 1, unitPrice: 10 }] };
    const key = `po-idem-${Date.now()}`;
    const first = await post("/api/purchase-orders", ops, body, key);
    const second = await post("/api/purchase-orders", ops, body, key);
    expect(first.body.id).toBe(second.body.id);
    expect(await prisma.purchaseOrder.count({ where: { prId: pr.id } })).toBe(1);
  });

  it("city scoping: a Goa-scoped user cannot raise a request against a Jaipur city", async () => {
    const goaOps = await loginAs(app, "meera.deshpande@ammbrands.in"); // Operations, Goa
    const res = await post("/api/purchase-requests", goaOps, { item: "Cross-city", vendorId, amount: 100, cityId });
    expect(res.status).toBe(403);
  });

  it("a blacklisted vendor cannot be purchased from", async () => {
    const v = await prisma.vendor.create({
      data: { workspaceId: (await prisma.workspace.findFirstOrThrow()).id, name: "ZZ Blacklisted test vendor", status: "BLACKLISTED", source: "test fixture" },
    });
    const res = await post("/api/purchase-requests", ops, { item: "Nope", vendorId: v.id, amount: 100, cityId });
    expect(res.status).toBe(400);
    await prisma.vendor.delete({ where: { id: v.id } });
  });
});
