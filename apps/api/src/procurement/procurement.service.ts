import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PrismaClient } from "@podium/db";
import type {
  CreatePurchaseRequestInput,
  CreatePurchaseOrderInput,
  ReceiveGoodsInput,
} from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { InventoryService } from "../inventory/inventory.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Procurement (blueprint §13): purchase_requests -> purchase_orders ->
 * goods_receipts, with an approval gate above a configurable value and every
 * receipt landing in the inventory ledger as a real RECEIVE movement.
 *
 * Two rules shape the whole module:
 *
 *  - A PO may only be raised from an APPROVED purchase request. The gate is
 *    enforced here, server-side, on the request's own amount — never on a
 *    client-supplied "needsApproval" flag, and never by hiding the button.
 *  - Receiving goods never writes a balance directly. It calls the inventory
 *    ledger's row-locked movement writer inside the same transaction as the
 *    goods_receipts row, so stock on hand always reconciles to
 *    SUM(inventory_movements) even if two storekeepers receive at once.
 */
@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly inventory: InventoryService,
  ) {}

  // ------------------------------------------------------------ requests

  async listRequests(user: RequestUser, cityId?: string) {
    const scope = this.cityScope.scopeFilter(user, cityId);
    return this.prisma.client.purchaseRequest.findMany({
      where: { deletedAt: null, vendor: { workspaceId: user.workspaceId }, ...scope },
      include: { vendor: true, project: true, approvals: true, purchaseOrders: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async getRequest(user: RequestUser, id: string) {
    const pr = await this.prisma.client.purchaseRequest.findFirst({
      where: { id, deletedAt: null, vendor: { workspaceId: user.workspaceId } },
      include: { vendor: true, project: true, approvals: true, purchaseOrders: { include: { items: true, goodsReceipts: true } } },
    });
    if (!pr) throw new NotFoundException("Purchase request not found.");
    this.cityScope.assertCanAccessCity(user, pr.cityId);
    return pr;
  }

  /**
   * Raises a request against a REAL vendor row. The vendor must already exist
   * in this workspace — procurement never invents a supplier, and AMM's 163
   * real vendors are the only legitimate targets.
   *
   * If the amount is at or above the workspace threshold, a PENDING approval
   * is created in the same transaction and the request goes to
   * APPROVAL_PENDING. Otherwise it is immediately eligible for a PO.
   */
  async createRequest(user: RequestUser, input: CreatePurchaseRequestInput) {
    const vendor = await this.prisma.client.vendor.findFirst({
      where: { id: input.vendorId, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!vendor) throw new BadRequestException("That vendor does not exist in this workspace.");
    if (vendor.status === "BLACKLISTED") {
      throw new BadRequestException(`${vendor.name} is blacklisted and cannot be purchased from.`);
    }

    let cityId = input.cityId ?? null;
    if (input.projectId) {
      const project = await this.prisma.client.project.findFirst({
        where: { id: input.projectId, workspaceId: user.workspaceId, deletedAt: null },
      });
      if (!project) throw new BadRequestException("That project does not exist in this workspace.");
      cityId = project.cityId;
    }
    if (!cityId) {
      throw new BadRequestException("A purchase request needs a city (directly, or via a project) so it can be scoped and approved.");
    }
    this.cityScope.assertCanAccessCity(user, cityId);

    const workspace = await this.prisma.client.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });
    const threshold = Number(workspace.procurementApprovalThreshold);
    const needsApproval = input.amount >= threshold;

    return this.prisma.client.$transaction(async (tx) => {
      const pr = await tx.purchaseRequest.create({
        data: {
          projectId: input.projectId ?? null,
          cityId,
          item: input.item,
          vendorId: vendor.id,
          amount: input.amount,
          notes: input.notes,
          requestedById: user.id,
          status: needsApproval ? "APPROVAL_PENDING" : "QUOTE_COMPARISON",
          createdById: user.id,
        },
      });

      if (needsApproval) {
        await tx.approval.create({
          data: {
            projectId: input.projectId ?? null,
            purchaseRequestId: pr.id,
            title: `Purchase: ${input.item} (${vendor.name})`,
            type: "PURCHASE",
            requesterId: user.id,
            approverRef: "Founder/Admin",
            status: "PENDING",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: "purchase_request.create",
          entityType: "purchase_request",
          entityId: pr.id,
          after: { vendorId: vendor.id, amount: input.amount, needsApproval, threshold },
        },
      });

      return { ...pr, needsApproval, threshold };
    });
  }

  /**
   * Decides the approval attached to a request. Kept here rather than in the
   * generic approvals module so the request's own status moves with it in the
   * same transaction — an APPROVED approval sitting next to an
   * APPROVAL_PENDING request is the kind of drift that lets a PO slip through.
   */
  async decideRequestApproval(user: RequestUser, id: string, approve: boolean, reason?: string) {
    const pr = await this.getRequest(user, id);
    const pending = pr.approvals.find((a) => a.status === "PENDING");
    if (!pending) throw new BadRequestException("This request has no pending approval.");

    /**
     * Separation of duties. The Operations role legitimately holds
     * `inventory:approve` (it approves stock adjustments), which means the
     * permission check alone would let the person who raised a ₹5-lakh purchase
     * sign it off themselves. An approval gate the requester can clear on their
     * own is not a gate, so the requester is refused here regardless of role —
     * including Founder and Admin.
     */
    if (pr.requestedById === user.id || pending.requesterId === user.id) {
      throw new ForbiddenException("You raised this purchase request, so you cannot approve it. Someone else must decide it.");
    }

    return this.prisma.client.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id: pending.id },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedAt: new Date(), decisionReason: reason },
      });
      const updated = await tx.purchaseRequest.update({
        where: { id: pr.id },
        data: { status: approve ? "QUOTE_COMPARISON" : "REJECTED" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: approve ? "purchase_request.approved" : "purchase_request.rejected",
          entityType: "purchase_request",
          entityId: pr.id,
          before: { status: pr.status },
          after: { status: updated.status, reason: reason ?? null },
        },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------- orders

  /**
   * Raises a PO from an approved request. The approval gate is re-checked here
   * against the database rather than trusted from the caller: this is the last
   * point before money is committed to a vendor.
   */
  async createOrder(user: RequestUser, input: CreatePurchaseOrderInput, idempotencyKey?: string) {
    // Replay check first: a retried request carrying the same key must return
    // the order it already created. Running the duplicate-PO guard before this
    // would turn a safe retry into a 400.
    if (idempotencyKey) {
      const existing = await this.prisma.client.purchaseOrder.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      if (existing) return existing;
    }

    const pr = await this.getRequest(user, input.prId);

    if (pr.status === "REJECTED") throw new BadRequestException("This purchase request was rejected.");
    if (pr.status === "APPROVAL_PENDING") {
      throw new BadRequestException("This purchase request is still awaiting approval — a purchase order cannot be raised yet.");
    }
    if (pr.purchaseOrders.some((po) => po.deletedAt === null)) {
      throw new BadRequestException("A purchase order already exists for this request.");
    }

    const skuIds = input.items.map((i) => i.skuId);
    const skus = await this.prisma.client.inventoryItem.findMany({
      where: { id: { in: skuIds }, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (skus.length !== new Set(skuIds).size) {
      throw new BadRequestException("One or more SKUs on this order do not exist in this workspace.");
    }

    // Totals are computed server-side from the line items; a client-supplied
    // total is never trusted (prompt §7).
    const total = input.items.reduce((sum, i) => sum + i.qtyOrdered * i.unitPrice, 0);

    /**
     * BUG-008 (found while building the Phase D procurement UI, fixed as
     * Phase D.1): a PO's total was never checked against the amount its
     * request was actually approved for. The approval gate above only ever
     * looked at the PR's own estimated `amount` at request time — nothing
     * stopped a ₹50,001 request from clearing approval and then raising a
     * ₹5,00,000 PO once real vendor quotes came in during quote comparison,
     * which defeats the entire point of a value-based approval threshold.
     *
     * Only requests that actually went through the approval gate are
     * constrained here — a below-threshold request was never given an
     * approved ceiling to begin with, and quote comparison legitimately
     * settling on a different (including higher) figure than the original
     * estimate is the normal, intended path for those. No tolerance band is
     * applied: the audit's own wording is a hard cap at the approved amount,
     * and inventing a fudge factor would be a bigger, undocumented policy
     * call this fix isn't meant to make.
     */
    const wasApproved = pr.approvals.some((a) => a.status === "APPROVED");
    if (wasApproved && total > Number(pr.amount)) {
      throw new BadRequestException(
        `This purchase order totals ₹${total.toLocaleString("en-IN")} but the request was only approved for ` +
          `₹${Number(pr.amount).toLocaleString("en-IN")}. Raise a new purchase request for the higher amount so ` +
          "it can go through approval again — an approved ceiling cannot be exceeded by a later PO.",
      );
    }

    return this.prisma.client.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.create({
        data: {
          prId: pr.id,
          vendorId: pr.vendorId,
          total,
          status: "DRAFT",
          idempotencyKey,
          createdById: user.id,
          items: {
            create: input.items.map((i) => ({ skuId: i.skuId, qtyOrdered: i.qtyOrdered, unitPrice: i.unitPrice })),
          },
        },
        include: { items: true },
      });
      await tx.purchaseRequest.update({ where: { id: pr.id }, data: { status: "PO_RAISED" } });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: "purchase_order.create",
          entityType: "purchase_order",
          entityId: po.id,
          after: { prId: pr.id, vendorId: pr.vendorId, total, lines: input.items.length },
        },
      });
      return po;
    });
  }

  async sendOrder(user: RequestUser, id: string) {
    const po = await this.getOrder(user, id);
    if (po.status !== "DRAFT") throw new BadRequestException(`A ${po.status} order cannot be sent.`);
    return this.transitionOrder(user, po.id, "SENT", "purchase_order.sent");
  }

  /** Closes a PO short — no further receipts accepted. */
  async closeOrder(user: RequestUser, id: string, reason?: string) {
    const po = await this.getOrder(user, id);
    if (po.status === "CANCELLED" || po.status === "CLOSED") {
      throw new BadRequestException(`This order is already ${po.status}.`);
    }
    return this.transitionOrder(user, po.id, "CLOSED", "purchase_order.closed", reason);
  }

  async cancelOrder(user: RequestUser, id: string, reason?: string) {
    const po = await this.getOrder(user, id);
    if (po.goodsReceipts.length > 0) {
      throw new BadRequestException("This order has goods receipts against it and cannot be cancelled — close it instead.");
    }
    return this.transitionOrder(user, po.id, "CANCELLED", "purchase_order.cancelled", reason);
  }

  async getOrder(user: RequestUser, id: string) {
    const po = await this.prisma.client.purchaseOrder.findFirst({
      where: { id, deletedAt: null, vendor: { workspaceId: user.workspaceId } },
      include: { items: { include: { sku: true } }, goodsReceipts: true, vendor: true, purchaseRequest: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found.");
    this.cityScope.assertCanAccessCity(user, po.purchaseRequest.cityId);
    return po;
  }

  async listOrders(user: RequestUser, cityId?: string) {
    const scope = this.cityScope.scopeFilter(user, cityId);
    return this.prisma.client.purchaseOrder.findMany({
      where: { deletedAt: null, vendor: { workspaceId: user.workspaceId }, purchaseRequest: { ...scope } },
      // BUG-010 (2026-09-12, found building Phase D frontend against this
      // endpoint): the list view shows each order's originating request
      // (item name), same as getOrder() below — omitting this relation left
      // every consumer of this list crashing on `po.purchaseRequest.item`.
      include: { vendor: true, items: true, goodsReceipts: true, purchaseRequest: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  private async transitionOrder(user: RequestUser, id: string, status: "SENT" | "CLOSED" | "CANCELLED", action: string, reason?: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
      const po = await tx.purchaseOrder.update({ where: { id }, data: { status } });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action,
          entityType: "purchase_order",
          entityId: id,
          before: { status: before.status },
          after: { status, reason: reason ?? null },
        },
      });
      return po;
    });
  }

  // ------------------------------------------------------------ receipts

  /**
   * Records a (possibly partial) goods receipt and moves the stock.
   *
   * Over-receiving is rejected line by line against what is still outstanding,
   * so the sum of receipts can never exceed the order. The PO status is then
   * derived from the receipts — PARTIALLY_RECEIVED or RECEIVED — rather than
   * being set by the caller.
   */
  async receiveGoods(user: RequestUser, poId: string, input: ReceiveGoodsInput, idempotencyKey?: string) {
    const po = await this.getOrder(user, poId);

    if (po.status === "DRAFT") throw new BadRequestException("Send the purchase order to the vendor before receiving against it.");
    if (po.status === "CANCELLED" || po.status === "CLOSED") {
      throw new BadRequestException(`A ${po.status} order cannot receive goods.`);
    }

    // InventoryLocation is scoped by city, not workspace — the city grant below
    // is what keeps a receipt inside the caller's tenant and cities.
    const location = await this.prisma.client.inventoryLocation.findFirst({
      where: { id: input.locationId, deletedAt: null, city: { workspaceId: user.workspaceId } },
    });
    if (!location) throw new BadRequestException("That inventory location does not exist in this workspace.");
    this.cityScope.assertCanAccessCity(user, location.cityId);

    const outstanding = await this.outstandingBySku(po.id, po.items);
    for (const line of input.lines) {
      const ordered = po.items.find((i) => i.skuId === line.skuId);
      if (!ordered) throw new BadRequestException("A received SKU is not on this purchase order.");
      const left = outstanding.get(line.skuId) ?? 0;
      if (line.qty > left) {
        throw new BadRequestException(
          `Cannot receive ${line.qty} of ${ordered.sku.sku}: only ${left} of ${ordered.qtyOrdered} are still outstanding.`,
        );
      }
    }

    return this.prisma.client.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          poId: po.id,
          locationId: location.id,
          receivedQty: Object.fromEntries(input.lines.map((l) => [l.skuId, l.qty])),
          note: input.note,
          receivedById: user.id,
        },
      });

      // Every received line becomes a real ledger movement, written through
      // the inventory service's row-locked path — never a direct balance write.
      for (const line of input.lines) {
        await this.inventory.recordMovementInTx(tx as Tx, {
          skuId: line.skuId,
          type: "RECEIVE",
          locationId: location.id,
          qty: line.qty,
          actorId: user.id,
          refType: "goods_receipt",
          refId: receipt.id,
          note: `GRN for PO ${po.id}`,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:${line.skuId}` : undefined,
        });
      }

      const after = await this.outstandingBySku(po.id, po.items, tx);
      const fullyReceived = [...after.values()].every((v) => v === 0);
      const status = fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } });
      if (fullyReceived) {
        await tx.purchaseRequest.update({ where: { id: po.prId }, data: { status: "GOODS_RECEIVED" } });
      }

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: "goods_receipt.create",
          entityType: "goods_receipt",
          entityId: receipt.id,
          after: { poId: po.id, locationId: location.id, lines: input.lines, poStatus: status },
        },
      });

      return { receipt, poStatus: status, outstanding: Object.fromEntries(after) };
    });
  }

  /** Ordered minus already-received, per SKU. */
  private async outstandingBySku(
    poId: string,
    items: { skuId: string; qtyOrdered: number }[],
    tx?: Tx,
  ): Promise<Map<string, number>> {
    const client = tx ?? this.prisma.client;
    const receipts = await client.goodsReceipt.findMany({ where: { poId } });
    const left = new Map(items.map((i) => [i.skuId, i.qtyOrdered]));
    for (const r of receipts) {
      for (const [skuId, qty] of Object.entries(r.receivedQty as Record<string, number>)) {
        if (left.has(skuId)) left.set(skuId, left.get(skuId)! - Number(qty));
      }
    }
    return left;
  }
}
