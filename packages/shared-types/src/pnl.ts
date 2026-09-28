import { z } from "zod";

/**
 * Hand-built P&L statements (Reports → P&L → Add P&L). Amounts are entered
 * positive; the section decides whether a line adds to or takes from profit:
 *
 *   Revenue − Direct costs            = Gross profit
 *   Gross profit − Operating expenses = Operating profit (EBITDA)
 *   Operating profit + Other income   = Profit before tax
 *   Profit before tax − Tax           = Net profit
 */
export const PNL_SECTIONS = ["REVENUE", "DIRECT_COST", "OPEX", "OTHER_INCOME", "TAX"] as const;
export type PnlSection = (typeof PNL_SECTIONS)[number];

export const pnlLineSchema = z.object({
  section: z.enum(PNL_SECTIONS),
  label: z.string().trim().min(1).max(200),
  amount: z.number().nonnegative().max(1e12),
});

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-30.")
  .optional()
  .nullable();

export const createPnlStatementSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    cityId: z.string().uuid().optional().nullable(),
    projectId: z.string().uuid().optional().nullable(),
    periodFrom: dateOnly,
    periodTo: dateOnly,
    notes: z.string().trim().max(2000).optional().nullable(),
    lines: z.array(pnlLineSchema).max(300),
  })
  .refine((s) => !s.periodFrom || !s.periodTo || s.periodFrom <= s.periodTo, { message: "The period can't end before it starts.", path: ["periodTo"] });
export type CreatePnlStatementInput = z.infer<typeof createPnlStatementSchema>;

export const updatePnlStatementSchema = createPnlStatementSchema;
export type UpdatePnlStatementInput = CreatePnlStatementInput;
