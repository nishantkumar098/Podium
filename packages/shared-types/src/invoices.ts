import { z } from "zod";

export const invoiceStatusEnum = z.enum([
  "DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED",
]);

export const invoiceScopeEnum = z.enum(["FIXED", "VARIABLE"]);
export const invoiceDocTypeEnum = z.enum(["TAX_INVOICE", "ESTIMATE"]);

/** The GST slabs a line may carry. */
export const GST_SLABS = [0, 0.05, 0.12, 0.18, 0.28] as const;

export const invoiceItemSchema = z.object({
  description: z.string().min(1),
  /// The smaller line printed under the description.
  detail: z.string().optional(),
  qty: z.number().positive().default(1),
  /// The noun after the quantity — "8 person", "2 counter", "1 job".
  unit: z.string().optional(),
  rate: z.number().nonnegative(),
  // A percentage, capped at 100: a discount above the line value would make
  // the taxable amount negative, which is a credit note, not an invoice line.
  discountPct: z.number().min(0).max(100).default(0),
  hsnSac: z.string().optional(),
  /// GST rate for the line as a fraction. Only the slabs GST actually has —
  /// a typo like 0.8 must be refused, not billed. Defaults to 18%.
  gstRate: z
    .number()
    .refine((v) => GST_SLABS.includes(v as (typeof GST_SLABS)[number]), "GST rate must be 0%, 5%, 12%, 18% or 28%.")
    .default(0.18),
  // Which printed section the line falls under. Defaults to FIXED so an
  // existing caller that knows nothing about scopes still produces a valid
  // single-section invoice.
  scope: invoiceScopeEnum.default("FIXED"),
});

export const createInvoiceSchema = z.object({
  clientId: z.string().uuid(),
  projectId: z.string().uuid(),
  cityId: z.string().uuid(),
  // Which trading brand the document is issued under (Elixir Coterie or The
  // Cocktail Shop). Optional so existing callers keep working.
  brandId: z.string().uuid().optional(),
  docType: invoiceDocTypeEnum.default("TAX_INVOICE"),
  dueDate: z.coerce.date(),
  paymentTerms: z.string().optional(),
  quotationRef: z.string().optional(),
  serviceLocation: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/**
 * Editing a DRAFT invoice.
 *
 * `clientId` and `projectId` are deliberately absent. Moving a draft to a
 * different client or project changes which GST treatment applies, which
 * numbering series it will take, and whose project it bills against — at
 * which point it is a different document and should be raised as one. Every
 * other field, including the whole line-item list, can be corrected.
 *
 * `items` replaces the list wholesale rather than patching it line by line.
 * A printed invoice numbers its lines 01, 02…, so the order is part of the
 * document; merging edits into an existing list makes that order depend on
 * the order the edits arrived in.
 */
export const updateInvoiceSchema = z.object({
  cityId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  docType: invoiceDocTypeEnum.optional(),
  dueDate: z.coerce.date().optional(),
  paymentTerms: z.string().optional().nullable(),
  quotationRef: z.string().optional().nullable(),
  serviceLocation: z.string().optional().nullable(),
  items: z.array(invoiceItemSchema).min(1).optional(),
});
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CHEQUE", "CARD", "OTHER"]),
  receivedAt: z.coerce.date().optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const createAdjustmentNoteSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1),
});
export type CreateAdjustmentNoteInput = z.infer<typeof createAdjustmentNoteSchema>;

export const cancelInvoiceSchema = z.object({
  reason: z.string().min(1).optional(),
});
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;
