import { z } from "zod";

/**
 * Procurement inputs (blueprint §13). Amounts and quantities are validated
 * here, but the approval threshold and the order total are never taken from
 * the client — both are computed server-side.
 */
export const createPurchaseRequestSchema = z.object({
  item: z.string().min(1).max(300),
  vendorId: z.string().uuid(),
  amount: z.number().positive(),
  /** Either a project (whose city is used) or an explicit city is required. */
  projectId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});
export type CreatePurchaseRequestInput = z.infer<typeof createPurchaseRequestSchema>;

export const decideRequestSchema = z.object({
  approve: z.boolean(),
  reason: z.string().max(1000).optional(),
});
export type DecideRequestInput = z.infer<typeof decideRequestSchema>;

export const createPurchaseOrderSchema = z.object({
  prId: z.string().uuid(),
  items: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        qtyOrdered: z.number().int().positive(),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const receiveGoodsSchema = z.object({
  locationId: z.string().uuid(),
  lines: z.array(z.object({ skuId: z.string().uuid(), qty: z.number().int().positive() })).min(1),
  note: z.string().max(1000).optional(),
});
export type ReceiveGoodsInput = z.infer<typeof receiveGoodsSchema>;

export const closeOrderSchema = z.object({ reason: z.string().max(1000).optional() });
export type CloseOrderInput = z.infer<typeof closeOrderSchema>;
