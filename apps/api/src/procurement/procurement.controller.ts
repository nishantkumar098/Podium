import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import {
  closeOrderSchema,
  createPurchaseOrderSchema,
  createPurchaseRequestSchema,
  decideRequestSchema,
  receiveGoodsSchema,
} from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { ProcurementService } from "./procurement.service";

@Controller()
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  // --------------------------------------------------------- requests
  @Get("purchase-requests")
  @RequirePermissions("inventory:view")
  listRequests(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.procurement.listRequests(user, cityId);
  }

  @Get("purchase-requests/:id")
  @RequirePermissions("inventory:view")
  getRequest(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.procurement.getRequest(user, id);
  }

  @Post("purchase-requests")
  @RequirePermissions("inventory:create")
  @Audit("purchase_request", "purchase_request.create")
  createRequest(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createPurchaseRequestSchema)) body: ReturnType<typeof createPurchaseRequestSchema.parse>,
  ) {
    return this.procurement.createRequest(user, body);
  }

  /** The approval gate. Only inventory:approve holders may decide. */
  @Post("purchase-requests/:id/decision")
  @RequirePermissions("inventory:approve")
  @Audit("purchase_request", "purchase_request.decision")
  decide(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(decideRequestSchema)) body: ReturnType<typeof decideRequestSchema.parse>,
  ) {
    return this.procurement.decideRequestApproval(user, id, body.approve, body.reason);
  }

  // ----------------------------------------------------------- orders
  @Get("purchase-orders")
  @RequirePermissions("inventory:view")
  listOrders(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.procurement.listOrders(user, cityId);
  }

  @Get("purchase-orders/:id")
  @RequirePermissions("inventory:view")
  getOrder(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.procurement.getOrder(user, id);
  }

  @Post("purchase-orders")
  @RequirePermissions("inventory:create")
  @Audit("purchase_order", "purchase_order.create")
  createOrder(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createPurchaseOrderSchema)) body: ReturnType<typeof createPurchaseOrderSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.procurement.createOrder(user, body, idempotencyKey);
  }

  @Post("purchase-orders/:id/send")
  @RequirePermissions("inventory:edit")
  @Audit("purchase_order", "purchase_order.sent")
  send(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.procurement.sendOrder(user, id);
  }

  @Post("purchase-orders/:id/close")
  @RequirePermissions("inventory:edit")
  @Audit("purchase_order", "purchase_order.closed")
  close(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeOrderSchema)) body: ReturnType<typeof closeOrderSchema.parse>,
  ) {
    return this.procurement.closeOrder(user, id, body.reason);
  }

  @Post("purchase-orders/:id/cancel")
  @RequirePermissions("inventory:edit")
  @Audit("purchase_order", "purchase_order.cancelled")
  cancel(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeOrderSchema)) body: ReturnType<typeof closeOrderSchema.parse>,
  ) {
    return this.procurement.cancelOrder(user, id, body.reason);
  }

  // --------------------------------------------------------- receipts
  @Post("purchase-orders/:id/receipts")
  @RequirePermissions("inventory:edit")
  @Audit("goods_receipt", "goods_receipt.create")
  receive(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(receiveGoodsSchema)) body: ReturnType<typeof receiveGoodsSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.procurement.receiveGoods(user, id, body, idempotencyKey);
  }
}
