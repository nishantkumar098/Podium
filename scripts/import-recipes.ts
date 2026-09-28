/**
 * Podium — import the cocktail recipe book (Cocktail_Recipe_Book.xlsx).
 *
 *   "Recipe Book" sheet  -> one recipe per row: spirit, method, glass,
 *                           garnish and the "Notes / to verify" column
 *   "Ingredients" sheet  -> one ingredient line per row: name, qty, qty (max)
 *                           for ranges, unit and note — kept exactly as
 *                           written (60 ml, 3 dash, 1 cube, "as needed")
 *
 * Ingredients are stored as written and NOT linked to stock items: the book
 * says "Bourbon whiskey", stock holds specific bottles, and guessing a brand
 * would be wrong. Link a line to a stock item later (Requirements → Edit) to
 * make it costable and checkable against store stock.
 *
 * Re-running is safe: a recipe that already exists (same name) is updated in
 * place and its ingredient list replaced, never duplicated. Menu price is
 * left at 0 (the book has none) — an existing price is kept.
 *
 * Usage:  pnpm recipes:import            # dry run
 *         pnpm recipes:import --apply
 * The file is read from PODIUM_IMPORT_DIR (default: the user's Downloads).
 */
import * as path from "node:path";
import { prisma } from "@podium/db";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const DIR = process.env.PODIUM_IMPORT_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
const FILE = "Cocktail_Recipe_Book.xlsx";
const IMPORTER = "nishant.kumar";

type Cell = string | number;
const text = (v: Cell | undefined) => String(v ?? "").trim();
const num = (v: Cell | undefined) => (v === "" || v === undefined || v === null ? null : Number(v));
const orNull = (s: string) => (s && s !== "—" && s !== "-" ? s : null);

interface Line {
  ingredient: string;
  qty: number | null;
  qtyMax: number | null;
  unit: string;
  note: string | null;
  qtyMl: number;
}
interface RecipeRow {
  name: string;
  spirit: string;
  method: string | null;
  glass: string;
  garnish: string | null;
  notes: string | null;
  lines: Line[];
}

function read(): RecipeRow[] {
  const wb = XLSX.readFile(path.join(DIR, FILE));
  const rows = (sheet: string) => XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[sheet]!, { header: 1, defval: "" });

  const book = rows("Recipe Book");
  const head = book.findIndex((r) => text(r[0]) === "#" && text(r[2]) === "Cocktail");
  if (head < 0) throw new Error("Recipe Book: header row (#, Spirit, Cocktail, …) not found.");
  const recipes = new Map<string, RecipeRow>();
  for (const r of book.slice(head + 1)) {
    const name = text(r[2]);
    if (!name || !Number(r[0])) continue;
    recipes.set(name.toLowerCase(), {
      name,
      spirit: text(r[1]),
      method: orNull(text(r[4])),
      glass: text(r[5]) || "—",
      garnish: orNull(text(r[6])),
      notes: orNull(text(r[9])),
      lines: [],
    });
  }

  const ing = rows("Ingredients");
  const ih = ing.findIndex((r) => text(r[1]) === "Cocktail" && text(r[3]) === "Ingredient");
  if (ih < 0) throw new Error("Ingredients: header row (Key, Cocktail, Spirit, Ingredient, …) not found.");
  for (const r of ing.slice(ih + 1)) {
    const cocktail = text(r[1]);
    const ingredient = text(r[3]);
    if (!cocktail || !ingredient) continue;
    const recipe = recipes.get(cocktail.toLowerCase());
    if (!recipe) throw new Error(`Ingredients: "${cocktail}" is not in the Recipe Book sheet.`);
    const qty = num(r[4]);
    const unit = text(r[6]) || "ml";
    recipe.lines.push({
      ingredient,
      qty,
      qtyMax: num(r[5]),
      unit,
      note: orNull(text(r[7])),
      qtyMl: qty !== null && unit.toLowerCase() === "ml" ? Math.round(qty) : 0,
    });
  }
  const empty = [...recipes.values()].filter((r) => r.lines.length === 0);
  if (empty.length) throw new Error(`No ingredients found for: ${empty.map((r) => r.name).join(", ")}`);
  return [...recipes.values()];
}

const fmtLine = (l: Line) => (l.qty === null ? `${l.ingredient} (${l.unit})` : `${l.qty}${l.qtyMax ? `–${l.qtyMax}` : ""} ${l.unit} ${l.ingredient}`);

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  const importer = await prisma.user.findFirstOrThrow({ where: { username: IMPORTER }, select: { id: true } });
  const recipes = read();
  const existing = await prisma.recipe.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } });
  const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r.id]));

  console.log(`${workspace.name} — ${FILE}: ${recipes.length} recipes, ${recipes.reduce((s, r) => s + r.lines.length, 0)} ingredient lines`);
  const bySpirit = new Map<string, number>();
  for (const r of recipes) bySpirit.set(r.spirit, (bySpirit.get(r.spirit) ?? 0) + 1);
  console.log(`   ${[...bySpirit.entries()].map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  for (const r of recipes) {
    console.log(`   ${byName.has(r.name.toLowerCase()) ? "update" : "new   "}  ${r.name.padEnd(20)} ${r.glass.padEnd(18)} ${r.lines.map(fmtLine).join(" · ")}`);
    if (r.notes) console.log(`            ↳ verify: ${r.notes}`);
  }
  if (!APPLY) return console.log("\nDry run — nothing was written. Re-run with --apply.");

  let created = 0;
  let updated = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const r of recipes) {
        const data = { name: r.name, glass: r.glass, spirit: r.spirit || null, method: r.method, garnish: r.garnish, notes: r.notes };
        const items = r.lines.map((l, position) => ({ ...l, position, skuId: null }));
        const id = byName.get(r.name.toLowerCase());
        if (id) {
          await tx.recipe.update({ where: { id }, data });
          await tx.recipeItem.deleteMany({ where: { recipeId: id } });
          await tx.recipeItem.createMany({ data: items.map((i) => ({ ...i, recipeId: id })) });
          updated += 1;
        } else {
          await tx.recipe.create({ data: { ...data, workspaceId: workspace.id, price: 0, items: { create: items } } });
          created += 1;
        }
      }
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: importer.id,
          action: "recipes.recipe_book_imported",
          entityType: "workspace",
          entityId: workspace.id,
          after: { file: FILE, recipes: recipes.length, created, updated },
        },
      });
    },
    { maxWait: 20_000, timeout: 120_000 },
  );
  console.log(`\nWritten: ${created} new recipes, ${updated} updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
