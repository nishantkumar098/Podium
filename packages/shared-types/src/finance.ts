import { z } from "zod";

// =========================================================================
// Budgets (Phase B)
// =========================================================================

export const budgetLineSchema = z.object({
  category: z.string().min(1),
  plannedAmount: z.number().nonnegative(),
});
export type BudgetLineInput = z.infer<typeof budgetLineSchema>;

export const createBudgetSchema = z.object({
  projectId: z.string().uuid(),
  lines: z.array(budgetLineSchema).min(1),
});
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

/**
 * Updating a budget replaces its lines wholesale rather than patching them
 * individually. A budget is a single coherent plan — editing one category in
 * isolation invites a total that no longer adds up to anything anyone agreed.
 */
export const updateBudgetSchema = z.object({
  lines: z.array(budgetLineSchema).min(1),
});
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

// =========================================================================
// Expenses (Phase B)
// =========================================================================

export const expenseStatusEnum = z.enum(["PENDING", "APPROVED", "REJECTED", "REIMBURSED"]);

export const createExpenseSchema = z.object({
  projectId: z.string().uuid(),
  category: z.string().min(1),
  amount: z.number().positive(),
  note: z.string().optional(),
  incurredAt: z.coerce.date().optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const decideExpenseSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  /**
   * Required on a rejection: telling someone their out-of-pocket claim is
   * refused without saying why is not an acceptable workflow. Optional on an
   * approval, where the amount speaks for itself.
   */
  reason: z.string().min(1).optional(),
});
export type DecideExpenseInput = z.infer<typeof decideExpenseSchema>;
