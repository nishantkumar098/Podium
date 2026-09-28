import { z } from "zod";

export const clientTypeEnum = z.enum(["INDIVIDUAL", "CORPORATE", "BRAND"]);

export const createClientSchema = z.object({
  name: z.string().min(1),
  type: clientTypeEnum,
  cityId: z.string().uuid(),
  gstin: z.string().optional(),
  gstStateCode: z.string().length(2).optional(),
  ltv: z.number().nonnegative().default(0),
  since: z.coerce.date().optional(),
  /**
   * Billing address, and how to reach them.
   *
   * `address` is not optional decoration: the invoice renderer prints it
   * under the recipient's name, and a GST invoice is required to carry the
   * recipient's address. These columns existed on the model from the start
   * but were missing from this schema, so nothing could ever set them —
   * which is how every invoice AMM has issued printed the placeholder
   * "Billing address as per client records" instead of an address.
   *
   * Nullable rather than required, because 52,000 imported clients have no
   * address and making it mandatory would block editing all of them.
   */
  address: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const updateClientSchema = createClientSchema.partial();
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
