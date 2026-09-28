import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateRecipeInput, RecipeItemInput, UpdateRecipeInput } from "@podium/shared-types";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

const RECIPE_INCLUDE = { items: { include: { item: true }, orderBy: { position: "asc" } } } as const;

/** An ingredient line as stored: name as written, amount + unit, optional stock link. */
function itemRow(i: RecipeItemInput, position: number, skuName?: string) {
  const qty = i.qty ?? (i.qtyMl !== undefined ? i.qtyMl : null);
  const unit = i.unit || "ml";
  return {
    skuId: i.skuId ?? null,
    ingredient: i.ingredient?.trim() || skuName || "",
    qty,
    qtyMax: i.qtyMax ?? null,
    unit,
    note: i.note?.trim() || null,
    position,
    // Volume for costing and liquid totals: the written amount when it's in ml.
    qtyMl: i.qtyMl ?? (qty !== null && unit.toLowerCase() === "ml" ? Math.round(qty) : 0),
  };
}

/**
 * Menu costing (Phase E): a recipe's real cost, computed server-side from
 * live inventory data every time — never stored. `standardCost` is priced
 * per whole unit (a bottle, a case — whatever `sizeMl` measures), so a
 * recipe using `qtyMl` of it costs `qtyMl * (standardCost / sizeMl)`. A SKU
 * with no `sizeMl` (a non-volume item — e.g. garnish sold by the piece)
 * cannot be priced this way; its line is flagged `costable: false` rather
 * than silently contributing 0 or a wrong number to the total, per the
 * standing rule that the server never emits a financial figure it isn't
 * sure of.
 */
@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: RequestUser) {
    const recipes = await this.prisma.client.recipe.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      include: RECIPE_INCLUDE,
      orderBy: { name: "asc" },
    });
    return recipes.map((r) => this.withCosting(r));
  }

  async get(user: RequestUser, id: string) {
    const recipe = await this.prisma.client.recipe.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
      include: RECIPE_INCLUDE,
    });
    if (!recipe) throw new NotFoundException("Recipe not found.");
    return this.withCosting(recipe);
  }

  async create(user: RequestUser, input: CreateRecipeInput) {
    const names = await this.assertSkusExist(user, input.items.map((i) => i.skuId));
    const recipe = await this.prisma.client.recipe.create({
      data: {
        workspaceId: user.workspaceId,
        name: input.name,
        glass: input.glass,
        spirit: input.spirit || null,
        method: input.method || null,
        garnish: input.garnish || null,
        notes: input.notes || null,
        garnishCost: input.garnishCost,
        price: input.price,
        items: { create: input.items.map((i, idx) => itemRow(i, idx, i.skuId ? names.get(i.skuId) : undefined)) },
      },
      include: RECIPE_INCLUDE,
    });
    return this.withCosting(recipe);
  }

  async update(user: RequestUser, id: string, input: UpdateRecipeInput) {
    const existing = await this.prisma.client.recipe.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!existing) throw new NotFoundException("Recipe not found.");
    const names = input.items ? await this.assertSkusExist(user, input.items.map((i) => i.skuId)) : new Map<string, string>();

    const { items, ...scalars } = input;
    const recipe = await this.prisma.client.$transaction(async (tx) => {
      await tx.recipe.update({ where: { id: existing.id }, data: scalars });
      // A recipe's item list is a single coherent formula, same reasoning as
      // budget lines — patching one ingredient in isolation risks a recipe
      // whose items no longer match what was actually agreed.
      if (items) {
        await tx.recipeItem.deleteMany({ where: { recipeId: existing.id } });
        await tx.recipeItem.createMany({ data: items.map((i, idx) => ({ recipeId: existing.id, ...itemRow(i, idx, i.skuId ? names.get(i.skuId) : undefined) })) });
      }
      return tx.recipe.findUniqueOrThrow({ where: { id: existing.id }, include: RECIPE_INCLUDE });
    });
    return this.withCosting(recipe);
  }

  async remove(user: RequestUser, id: string) {
    const existing = await this.prisma.client.recipe.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!existing) throw new NotFoundException("Recipe not found.");
    return this.prisma.client.recipe.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  }

  /** Linked stock items must exist here; returns their names (the default ingredient name). */
  private async assertSkusExist(user: RequestUser, ids: Array<string | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const found = await this.prisma.client.inventoryItem.findMany({
      where: { id: { in: unique }, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (found.length !== unique.length) throw new BadRequestException("One or more items in this recipe do not exist in this workspace.");
    return new Map(found.map((f) => [f.id, f.name]));
  }

  private withCosting<
    T extends { garnishCost: unknown; price: unknown; items: Array<{ qtyMl: number; item: { standardCost: unknown; sizeMl: number | null } | null }> },
  >(recipe: T) {
    const garnishCost = Number(recipe.garnishCost);
    const price = Number(recipe.price);
    let ingredientCost = 0;
    let allCostable = true;
    const lines = recipe.items.map((i) => {
      // Unlinked (recipe-book) lines, non-volume stock and non-ml amounts can't be priced.
      if (!i.item || !i.item.sizeMl || i.item.sizeMl <= 0 || i.qtyMl <= 0) {
        allCostable = false;
        return { costable: false as const, cost: null };
      }
      const cost = i.qtyMl * (Number(i.item.standardCost) / i.item.sizeMl);
      ingredientCost += cost;
      return { costable: true as const, cost };
    });
    const totalCost = allCostable ? ingredientCost + garnishCost : null;
    const margin = totalCost === null ? null : price - totalCost;
    const marginPct = margin === null || price <= 0 ? null : Math.round((margin / price) * 1000) / 10;
    return {
      ...recipe,
      items: recipe.items.map((i, idx) => ({ ...i, ...lines[idx] })),
      costing: { ingredientCost: allCostable ? ingredientCost : null, garnishCost, totalCost, margin, marginPct, allCostable },
    };
  }
}
