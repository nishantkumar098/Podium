import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { createMovementSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { InventoryService } from "./inventory.service";

const itemSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(30),
  sizeMl: z.number().int().positive().nullish(),
  standardCost: z.number().nonnegative(),
  preferredVendorId: z.string().uuid().nullish(),
});
const importSchema = z.object({ productIds: z.array(z.string().uuid()).min(1).max(200) });
const reorderSchema = z.object({ skuId: z.string().uuid(), locationId: z.string().uuid(), reorderLevel: z.number().int().min(0) });
const reserveSchema = z.object({
  projectId: z.string().uuid(),
  locationId: z.string().uuid(),
  lines: z.array(z.object({ skuId: z.string().uuid(), qty: z.number().int().positive() })).min(1).max(100),
});

@Controller("inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("items")
  @RequirePermissions("inventory:view")
  items(@CurrentUser() user: RequestUser) {
    return this.inventory.listItems(user);
  }

  @Get("balances")
  @RequirePermissions("inventory:view")
  balances(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.inventory.listBalances(user, cityId);
  }

  /** All inventory mutation goes through this one endpoint, typed by `type` (blueprint §40). */
  @Post("movements")
  @RequirePermissions("inventory:edit")
  @Audit("inventory_movement", "inventory.movement")
  createMovement(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createMovementSchema)) body: ReturnType<typeof createMovementSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.inventory.createMovement(user, body, idempotencyKey);
  }

  /** Stores, per-store balances with reservations, headline figures and recent movements. */
  @Get("overview")
  @RequirePermissions("inventory:view")
  overview(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.inventory.overview(user, cityId || undefined);
  }

  @Post("stores/setup")
  @RequirePermissions("inventory:edit")
  setupStores(@CurrentUser() user: RequestUser) {
    return this.inventory.setupStores(user);
  }

  @Post("items")
  @RequirePermissions("inventory:create")
  createItem(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(itemSchema)) body: z.infer<typeof itemSchema>) {
    return this.inventory.createItem(user, body);
  }

  @Patch("items/:id")
  @RequirePermissions("inventory:edit")
  updateItem(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(itemSchema.partial())) body: Partial<z.infer<typeof itemSchema>>) {
    return this.inventory.updateItem(user, id, body);
  }

  @Post("items/from-products")
  @RequirePermissions("inventory:create")
  importFromProducts(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(importSchema)) body: z.infer<typeof importSchema>) {
    return this.inventory.importFromProducts(user, body.productIds);
  }

  @Put("reorder-level")
  @RequirePermissions("inventory:edit")
  setReorder(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(reorderSchema)) body: z.infer<typeof reorderSchema>) {
    return this.inventory.setReorderLevel(user, body.skuId, body.locationId, body.reorderLevel);
  }

  @Post("reservations")
  @RequirePermissions("inventory:edit")
  reserve(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(reserveSchema)) body: z.infer<typeof reserveSchema>) {
    return this.inventory.reserve(user, body);
  }

  @Delete("reservations/:id")
  @RequirePermissions("inventory:edit")
  release(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.inventory.release(user, id);
  }
}
