import { z } from "zod";

/**
 * Menu costing (blueprint §19/§40, Phase E): a recipe's ingredient list
 * against real inventory items, priced against their real standardCost.
 * The server always computes cost/margin from live `standard_cost` and
 * `size_ml` at read time — never stored or trusted from the client — so a
 * SKU's cost changing (a new vendor quote, a purchase-order rate change)
 * is reflected on every recipe that uses it without any recipe edit.
 */
/**
 * One ingredient line. Either linked to a stock item (`skuId` — costable and
 * checkable against store stock) or free-text as written in a recipe book
 * (`ingredient`), or both. Quantity is as written: `qty` + `unit` (60 ml,
 * 3 dash, 1 cube), `qtyMax` for the top of a range (8–10 leaves), and no
 * `qty` at all for "as needed". `qtyMl` (whole ml) is still accepted from
 * older callers; otherwise it is derived from qty when the unit is ml.
 */
export const recipeItemSchema = z
  .object({
    skuId: z.string().uuid().optional(),
    ingredient: z.string().trim().max(200).optional(),
    qty: z.number().positive().nullable().optional(),
    qtyMax: z.number().positive().nullable().optional(),
    unit: z.string().trim().min(1).max(30).default("ml"),
    note: z.string().trim().max(300).optional(),
    qtyMl: z.number().int().positive().optional(),
  })
  .refine((i) => !!i.skuId || !!i.ingredient, { message: "Each ingredient needs a name or a stock item." })
  .refine((i) => i.qtyMax == null || i.qty == null || i.qtyMax >= i.qty, { message: "A range's upper amount can't be below its lower amount." });
export type RecipeItemInput = z.infer<typeof recipeItemSchema>;

export const createRecipeSchema = z.object({
  name: z.string().min(1).max(200),
  glass: z.string().min(1).max(120),
  spirit: z.string().trim().max(60).optional(),
  method: z.string().trim().max(300).optional(),
  garnish: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
  garnishCost: z.number().nonnegative().default(0),
  /** 0 = not priced yet — recipe-book entries have no menu price. */
  price: z.number().nonnegative().default(0),
  items: z.array(recipeItemSchema).min(1),
});
export type CreateRecipeInput = z.infer<typeof createRecipeSchema>;

export const updateRecipeSchema = createRecipeSchema.partial();
export type UpdateRecipeInput = z.infer<typeof updateRecipeSchema>;
