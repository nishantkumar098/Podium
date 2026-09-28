import { z } from "zod";

export const vendorStatusEnum = z.enum(["PREFERRED", "APPROVED", "BLACKLISTED"]);

export const createVendorSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional().nullable(),
  /** Null for a supplier outside AMM's branch cities (Gujarat, Haryana…). */
  cityId: z.string().uuid().optional().nullable(),
  contactName: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.union([z.string().email(), z.literal("")]).optional().nullable(),
  address: z.string().optional().nullable(),
  rating: z.number().min(0).max(5).optional().nullable(),
  gstin: z.string().optional().nullable(),
  status: vendorStatusEnum.default("APPROVED"),
  // From AMM's vendor sheet.
  brand: z.string().max(60).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
  pan: z.string().max(20).optional().nullable(),
  bankName: z.string().max(120).optional().nullable(),
  bankAccountNo: z.string().max(40).optional().nullable(),
  bankIfsc: z.string().max(20).optional().nullable(),
  upiId: z.string().max(120).optional().nullable(),
  paymentTerms: z.string().max(60).optional().nullable(),
  creditDays: z.number().int().min(0).max(365).optional().nullable(),
  remarks: z.string().max(1000).optional().nullable(),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema.partial();
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
