import { z } from "zod";

export const inventoryMovementTypeEnum = z.enum([
  "PURCHASE", "RECEIVE", "RESERVE", "CONSUME", "TRANSFER_OUT", "TRANSFER_IN", "DAMAGE", "ADJUSTMENT", "RETURN",
]);

/**
 * All inventory mutation goes through this one shape (blueprint §40).
 * TRANSFER is expressed as a paired TRANSFER_OUT (fromLocationId set) +
 * TRANSFER_IN (toLocationId set) — the service posts both atomically.
 */
export const createMovementSchema = z.object({
  skuId: z.string().uuid(),
  type: inventoryMovementTypeEnum,
  fromLocationId: z.string().uuid().optional(),
  toLocationId: z.string().uuid().optional(),
  qty: z.number().int().positive(),
  refType: z.string().optional(),
  refId: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
});
export type CreateMovementInput = z.infer<typeof createMovementSchema>;
