import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@podium/db";
import type { CreateMovementInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { allowedCityIds, type RequestUser } from "../common/types";

export interface ItemInput {
  sku: string;
  name: string;
  category: string;
  unit: string;
  sizeMl?: number | null;
  standardCost: number;
  preferredVendorId?: string | null;
}

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

const DECREMENTS_FROM = new Set(["CONSUME", "DAMAGE", "TRANSFER_OUT"]);
const INCREMENTS_TO = new Set(["RECEIVE", "TRANSFER_IN", "RETURN", "PURCHASE"]);

/**
 * The inventory ledger (blueprint §14). inventory_balances is NEVER written
 * to directly from outside this service — every change is an
 * inventory_movements row, and the balance is recomputed under a row lock
 * (SELECT ... FOR UPDATE) inside the same transaction as the movement
 * insert. This is the direct fix for the prototype's `qty[cityIdx] -= n`
 * in-place array mutation, which had no concurrency control at all.
 *
 * RESERVE/consume-of-reservation are deliberately NOT handled as balance-
 * affecting movements here — reservations live in inventory_reservations
 * and reduce *available* stock (qtyOnHand - reserved), not qtyOnHand itself.
 * Recipe-driven auto-reservation from guest count x drinks is schema-ready
 * (recipe_items, inventory_reservations) but not yet wired to an endpoint —
 * see docs/STATUS.md.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  /**
   * The full SKU catalog — unlike listBalances(), not filtered to items that
   * happen to have a balance row somewhere. Recipes (Phase E) need to
   * reference a SKU (e.g. a newly added garnish) before it has ever been
   * received into stock anywhere, so balances is the wrong source for that
   * picker. Not city-scoped: InventoryItem is a workspace-level catalog
   * entry, not tied to any one location.
   */
  listItems(user: RequestUser) {
    return this.prisma.client.inventoryItem.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      orderBy: { name: "asc" },
    });
  }

  async listBalances(user: RequestUser, cityId?: string) {
    // scopeFilter() returns a filter shaped for a model with its own
    // `cityId` column (e.g. `{ cityId: { in: [...] } }`) -- InventoryLocation
    // has that column directly, so the scope applies to `location`, not to
    // `location.city` (City's own key is `id`, not `cityId`; nesting the
    // scope filter there produced an invalid Prisma query that 500'd for
    // every non-ALL-scope caller -- caught by the RBAC audit, not by the
    // original test suite, since every inventory test happened to run as
    // an ALL-scope Admin/Founder user).
    const scope = this.cityScope.scopeFilter(user, cityId);
    return this.prisma.client.inventoryBalance.findMany({
      where: {
        item: { workspaceId: user.workspaceId },
        location: { ...scope },
      },
      include: { item: true, location: { include: { city: true } } },
      orderBy: [{ item: { name: "asc" } }],
    });
  }

  async createMovement(user: RequestUser, input: CreateMovementInput, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.client.inventoryMovement.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }
    if (input.type === "TRANSFER_OUT" || input.type === "TRANSFER_IN") {
      if (!input.fromLocationId || !input.toLocationId) {
        throw new BadRequestException("Transfers require both fromLocationId and toLocationId.");
      }
      return this.transfer(user, input, idempotencyKey);
    }
    if (DECREMENTS_FROM.has(input.type) && !input.fromLocationId) {
      throw new BadRequestException(`${input.type} requires fromLocationId.`);
    }
    if (INCREMENTS_TO.has(input.type) && !input.toLocationId) {
      throw new BadRequestException(`${input.type} requires toLocationId.`);
    }
    if (input.type === "ADJUSTMENT" && !input.fromLocationId && !input.toLocationId) {
      throw new BadRequestException("ADJUSTMENT requires fromLocationId (decrease) or toLocationId (increase).");
    }

    return this.prisma.client.$transaction(async (tx) => {
      const locationId = input.fromLocationId ?? input.toLocationId!;
      const location = await tx.inventoryLocation.findUniqueOrThrow({ where: { id: locationId }, include: { city: true } });
      this.cityScope.assertCanAccessCity(user, location.cityId);

      const decrement = DECREMENTS_FROM.has(input.type) || (input.type === "ADJUSTMENT" && !!input.fromLocationId);
      await this.applyBalanceDelta(tx, input.skuId, locationId, decrement ? -input.qty : input.qty);

      return tx.inventoryMovement.create({
        data: {
          skuId: input.skuId,
          type: input.type,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          qty: input.qty,
          refType: input.refType,
          refId: input.refId,
          actorId: user.id,
          note: input.note,
          idempotencyKey,
        },
      });
    });
  }

  private async transfer(user: RequestUser, input: CreateMovementInput, idempotencyKey?: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const [fromLoc, toLoc] = await Promise.all([
        tx.inventoryLocation.findUniqueOrThrow({ where: { id: input.fromLocationId! } }),
        tx.inventoryLocation.findUniqueOrThrow({ where: { id: input.toLocationId! } }),
      ]);
      this.cityScope.assertCanAccessCity(user, fromLoc.cityId);
      this.cityScope.assertCanAccessCity(user, toLoc.cityId);

      await this.applyBalanceDelta(tx, input.skuId, fromLoc.id, -input.qty);
      await this.applyBalanceDelta(tx, input.skuId, toLoc.id, input.qty);

      const out = await tx.inventoryMovement.create({
        data: {
          skuId: input.skuId, type: "TRANSFER_OUT", fromLocationId: fromLoc.id, toLocationId: toLoc.id,
          qty: input.qty, refType: input.refType, refId: input.refId, actorId: user.id, note: input.note,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:out` : undefined,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          skuId: input.skuId, type: "TRANSFER_IN", fromLocationId: fromLoc.id, toLocationId: toLoc.id,
          qty: input.qty, refType: input.refType, refId: input.refId, actorId: user.id, note: input.note,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : undefined,
        },
      });
      return out;
    });
  }

  /**
   * The single supported way for another module to write to the ledger.
   * Procurement's goods receipts call this inside their own transaction, so a
   * received PO line and its RECEIVE movement and the balance change are one
   * atomic unit — and so there is exactly one implementation of the row-locked
   * balance update, not a second copy that could drift from this one.
   */
  async recordMovementInTx(
    tx: Tx,
    params: {
      skuId: string;
      type: "RECEIVE" | "PURCHASE" | "RETURN" | "CONSUME" | "DAMAGE" | "ADJUSTMENT";
      locationId: string;
      qty: number;
      actorId: string;
      refType?: string;
      refId?: string;
      note?: string;
      idempotencyKey?: string;
    },
  ) {
    const decrement = DECREMENTS_FROM.has(params.type);
    await this.applyBalanceDelta(tx, params.skuId, params.locationId, decrement ? -params.qty : params.qty);
    return tx.inventoryMovement.create({
      data: {
        skuId: params.skuId,
        type: params.type,
        fromLocationId: decrement ? params.locationId : null,
        toLocationId: decrement ? null : params.locationId,
        qty: params.qty,
        refType: params.refType,
        refId: params.refId,
        actorId: params.actorId,
        note: params.note,
        idempotencyKey: params.idempotencyKey,
      },
    });
  }

  // ------------------------------------------------------------ overview

  /**
   * Everything the Inventory screen shows, in one response: each city store,
   * each item's on-hand / reserved / available / reorder level per store,
   * headline figures and the latest movements. Queries run side by side.
   */
  async overview(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    const scope = this.cityScope.scopeFilter(user, cityId);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [locations, items, balances, reservations, movements, movesThisWeek] = await Promise.all([
      db.inventoryLocation.findMany({
        where: { deletedAt: null, city: { workspaceId: user.workspaceId }, ...scope },
        select: { id: true, name: true, cityId: true, city: { select: { name: true, state: true } } },
        orderBy: { city: { name: "asc" } },
      }),
      db.inventoryItem.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null },
        select: {
          id: true, sku: true, name: true, category: true, unit: true, sizeMl: true, standardCost: true,
          preferredVendor: { select: { id: true, name: true } },
        },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      }),
      db.inventoryBalance.findMany({
        where: { item: { workspaceId: user.workspaceId, deletedAt: null }, location: { deletedAt: null, ...scope } },
        select: { skuId: true, locationId: true, qtyOnHand: true, reorderLevel: true },
      }),
      db.inventoryReservation.findMany({
        where: { status: "RESERVED", location: { deletedAt: null, ...scope }, item: { workspaceId: user.workspaceId } },
        select: { id: true, skuId: true, locationId: true, qty: true, project: { select: { id: true, name: true, eventDate: true } } },
      }),
      db.inventoryMovement.findMany({
        where: { item: { workspaceId: user.workspaceId } },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true, type: true, qty: true, note: true, createdAt: true, actorId: true,
          item: { select: { name: true, unit: true } },
          fromLocation: { select: { city: { select: { name: true } } } },
          toLocation: { select: { city: { select: { name: true } } } },
        },
      }),
      db.inventoryMovement.count({ where: { item: { workspaceId: user.workspaceId }, createdAt: { gte: weekAgo } } }),
    ]);
    const actors = await db.user.findMany({ where: { id: { in: [...new Set(movements.map((m) => m.actorId))] } }, select: { id: true, name: true } });
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    const key = (sku: string, loc: string) => `${sku}:${loc}`;
    const bal = new Map(balances.map((b) => [key(b.skuId, b.locationId), b]));
    const reserved = new Map<string, number>();
    for (const r of reservations) reserved.set(key(r.skuId, r.locationId), (reserved.get(key(r.skuId, r.locationId)) ?? 0) + r.qty);

    let stockValue = 0;
    let reservedValue = 0;
    let belowReorder = 0;
    const rows = items.map((it) => {
      const cost = it.standardCost.toNumber();
      const stores = locations.map((l) => {
        const b = bal.get(key(it.id, l.id));
        const onHand = b?.qtyOnHand ?? 0;
        const res = reserved.get(key(it.id, l.id)) ?? 0;
        const available = onHand - res;
        const reorderLevel = b?.reorderLevel ?? 0;
        const low = reorderLevel > 0 && available <= reorderLevel;
        stockValue += onHand * cost;
        reservedValue += res * cost;
        if (low) belowReorder++;
        return { locationId: l.id, onHand, reserved: res, available, reorderLevel, low };
      });
      return {
        id: it.id, sku: it.sku, name: it.name, category: it.category, unit: it.unit, sizeMl: it.sizeMl, cost,
        vendor: it.preferredVendor, stores, total: stores.reduce((s, x) => s + x.onHand, 0),
      };
    });

    return {
      locations: locations.map((l) => ({ id: l.id, name: l.name, cityId: l.cityId, city: l.city.name, state: l.city.state })),
      items: rows,
      categories: [...new Set(items.map((i) => i.category))],
      stats: {
        stockValue: Math.round(stockValue * 100) / 100,
        belowReorder,
        reservedValue: Math.round(reservedValue * 100) / 100,
        reservations: reservations.length,
        movementsThisWeek: movesThisWeek,
      },
      reservations: reservations.map((r) => ({ ...r, location: locations.find((l) => l.id === r.locationId)?.city.name ?? "—" })),
      movements: movements.map((m) => ({
        id: m.id, type: m.type, qty: m.qty, note: m.note, at: m.createdAt,
        item: m.item.name, unit: m.item.unit,
        from: m.fromLocation?.city.name ?? null, to: m.toLocation?.city.name ?? null,
        by: actorName.get(m.actorId) ?? "—",
      })),
    };
  }

  // --------------------------------------------------------------- setup

  /** One store per city the caller can manage that doesn't have one yet ("Jaipur store"). */
  async setupStores(user: RequestUser) {
    const db = this.prisma.client;
    const allowed = allowedCityIds(user);
    const cities = await db.city.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...(allowed === "ALL" ? {} : { id: { in: allowed } }) },
      select: { id: true, name: true, inventoryLocations: { where: { deletedAt: null }, select: { id: true } } },
    });
    const missing = cities.filter((c) => c.inventoryLocations.length === 0);
    for (const c of missing) {
      const loc = await db.inventoryLocation.create({ data: { cityId: c.id, name: `${c.name} store` } });
      await this.audit(user, "inventory.store_created", "inventory_location", loc.id, { name: loc.name, cityId: c.id });
    }
    return { created: missing.map((c) => `${c.name} store`) };
  }

  async createItem(user: RequestUser, input: ItemInput) {
    const db = this.prisma.client;
    const sku = input.sku.trim().toUpperCase();
    const clash = await db.inventoryItem.findFirst({ where: { workspaceId: user.workspaceId, sku } });
    if (clash) throw new BadRequestException(`SKU ${sku} already exists (${clash.name}).`);
    await this.assertVendor(user, input.preferredVendorId);
    const item = await db.inventoryItem.create({
      data: {
        workspaceId: user.workspaceId,
        sku,
        name: input.name.trim(),
        category: input.category.trim(),
        unit: input.unit.trim(),
        sizeMl: input.sizeMl ?? null,
        standardCost: input.standardCost,
        preferredVendorId: input.preferredVendorId ?? null,
      },
    });
    await this.audit(user, "inventory.item_created", "inventory_item", item.id, { sku, name: item.name });
    return item;
  }

  async updateItem(user: RequestUser, id: string, input: Partial<ItemInput>) {
    const db = this.prisma.client;
    const item = await db.inventoryItem.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!item) throw new NotFoundException("Item not found.");
    await this.assertVendor(user, input.preferredVendorId);
    const updated = await db.inventoryItem.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.category !== undefined ? { category: input.category.trim() } : {}),
        ...(input.unit !== undefined ? { unit: input.unit.trim() } : {}),
        ...(input.sizeMl !== undefined ? { sizeMl: input.sizeMl } : {}),
        ...(input.standardCost !== undefined ? { standardCost: input.standardCost } : {}),
        ...(input.preferredVendorId !== undefined ? { preferredVendorId: input.preferredVendorId } : {}),
      },
    });
    await this.audit(user, "inventory.item_updated", "inventory_item", id, { sku: item.sku, ...input });
    return updated;
  }

  /**
   * Stock items from the product catalogue (Elixir Coterie / The Cocktail
   * Shop). The catalogue holds selling prices, not purchase costs, so the
   * unit cost starts at 0 and is flagged for the team to fill in — using the
   * selling price as cost would overstate every recipe and stock value.
   */
  async importFromProducts(user: RequestUser, productIds: string[]) {
    const db = this.prisma.client;
    const products = await db.product.findMany({
      where: { id: { in: productIds }, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, sku: true, externalRef: true, name: true, category: true, unit: true },
    });
    const existing = new Set(
      (await db.inventoryItem.findMany({ where: { workspaceId: user.workspaceId }, select: { sku: true } })).map((i) => i.sku),
    );
    const created: string[] = [];
    const skipped: string[] = [];
    for (const p of products) {
      const sku = (p.sku || p.externalRef).trim().toUpperCase();
      if (existing.has(sku)) {
        skipped.push(p.name);
        continue;
      }
      const item = await db.inventoryItem.create({
        data: { workspaceId: user.workspaceId, sku, name: p.name, category: p.category || "Uncategorised", unit: p.unit || "unit", standardCost: 0 },
      });
      existing.add(sku);
      created.push(item.name);
    }
    if (created.length) await this.audit(user, "inventory.items_imported", "inventory_item", user.workspaceId, { count: created.length });
    return { created: created.length, skipped };
  }

  /** Reorder level for one item at one store (creates the balance row at 0 on hand if new). */
  async setReorderLevel(user: RequestUser, skuId: string, locationId: string, reorderLevel: number) {
    const db = this.prisma.client;
    const location = await db.inventoryLocation.findFirst({ where: { id: locationId, deletedAt: null, city: { workspaceId: user.workspaceId } } });
    if (!location) throw new NotFoundException("Store not found.");
    this.cityScope.assertCanAccessCity(user, location.cityId);
    const item = await db.inventoryItem.findFirst({ where: { id: skuId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!item) throw new NotFoundException("Item not found.");
    return db.inventoryBalance.upsert({
      where: { skuId_locationId: { skuId, locationId } },
      update: { reorderLevel },
      create: { skuId, locationId, qtyOnHand: 0, reorderLevel },
    });
  }

  // -------------------------------------------------------- reservations

  /**
   * Holds stock at one store for an event. Checked against *available* stock
   * (on hand minus existing reservations) under a lock on each balance row, so
   * two planners can't both promise the last bottles.
   */
  async reserve(user: RequestUser, input: { projectId: string; locationId: string; lines: Array<{ skuId: string; qty: number }> }) {
    const db = this.prisma.client;
    const [project, location] = await Promise.all([
      db.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId, deletedAt: null } }),
      db.inventoryLocation.findFirst({ where: { id: input.locationId, deletedAt: null, city: { workspaceId: user.workspaceId } } }),
    ]);
    if (!project) throw new NotFoundException("Project not found.");
    if (!location) throw new NotFoundException("Store not found.");
    this.cityScope.assertCanAccessCity(user, location.cityId);

    return db.$transaction(async (tx) => {
      const made: Array<{ id: string }> = [];
      for (const line of input.lines.filter((l) => l.qty > 0)) {
        const [row] = await tx.$queryRaw<Array<{ qty_on_hand: number }>>(
          Prisma.sql`SELECT qty_on_hand FROM inventory_balances WHERE sku_id = ${line.skuId}::uuid AND location_id = ${location.id}::uuid FOR UPDATE`,
        );
        const held = await tx.inventoryReservation.aggregate({
          where: { skuId: line.skuId, locationId: location.id, status: "RESERVED" },
          _sum: { qty: true },
        });
        const available = (row?.qty_on_hand ?? 0) - (held._sum.qty ?? 0);
        if (line.qty > available) {
          const item = await tx.inventoryItem.findUnique({ where: { id: line.skuId }, select: { name: true } });
          throw new BadRequestException(`Only ${Math.max(available, 0)} ${item?.name ?? "units"} available at ${location.name}.`);
        }
        made.push(
          await tx.inventoryReservation.create({
            data: { skuId: line.skuId, locationId: location.id, projectId: project.id, qty: line.qty, status: "RESERVED" },
          }),
        );
      }
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "inventory.reserved", entityType: "project", entityId: project.id,
          after: { projectId: project.id, store: location.name, lines: made.length },
        },
      });
      return { reserved: made.length };
    });
  }

  async release(user: RequestUser, reservationId: string) {
    const db = this.prisma.client;
    const r = await db.inventoryReservation.findFirst({
      where: { id: reservationId, status: "RESERVED", item: { workspaceId: user.workspaceId } },
      include: { location: true },
    });
    if (!r) throw new NotFoundException("Reservation not found or already released.");
    this.cityScope.assertCanAccessCity(user, r.location.cityId);
    await db.inventoryReservation.update({ where: { id: r.id }, data: { status: "RELEASED" } });
    await this.audit(user, "inventory.released", "project", r.projectId, { projectId: r.projectId, qty: r.qty });
    return { ok: true };
  }

  // --------------------------------------------------------------- helpers

  private async assertVendor(user: RequestUser, vendorId: string | null | undefined) {
    if (!vendorId) return;
    const v = await this.prisma.client.vendor.findFirst({ where: { id: vendorId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!v) throw new BadRequestException("Vendor not found.");
  }

  private async audit(user: RequestUser, action: string, entityType: string, entityId: string, after: Record<string, unknown>) {
    await this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action, entityType, entityId, after: after as object },
    });
  }

  /**
   * Row-locks the (sku, location) balance and applies `delta`, creating the
   * balance row first (qty 0) if this is the first movement ever recorded
   * for that pair. Throws if a decrement would take on-hand stock negative —
   * the ledger is the source of truth, so this check is authoritative, not
   * advisory.
   */
  private async applyBalanceDelta(tx: Tx, skuId: string, locationId: string, delta: number) {
    await tx.inventoryBalance.upsert({
      where: { skuId_locationId: { skuId, locationId } },
      update: {},
      create: { skuId, locationId, qtyOnHand: 0, reorderLevel: 0 },
    });
    const [locked] = await tx.$queryRaw<Array<{ qty_on_hand: number }>>(
      Prisma.sql`SELECT qty_on_hand FROM inventory_balances WHERE sku_id = ${skuId}::uuid AND location_id = ${locationId}::uuid FOR UPDATE`,
    );
    const newQty = (locked?.qty_on_hand ?? 0) + delta;
    if (newQty < 0) {
      throw new BadRequestException("This movement would take on-hand stock negative.");
    }
    await tx.$executeRaw(
      Prisma.sql`UPDATE inventory_balances SET qty_on_hand = ${newQty}, updated_at = now() WHERE sku_id = ${skuId}::uuid AND location_id = ${locationId}::uuid`,
    );
  }
}
