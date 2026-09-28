/**
 * Podium — import opening stock into the city stores.
 *
 *   GREEN PARK  INVENTORY.xlsx   -> the Delhi store ("Green Park (Delhi)")
 *   inventory-by-city.xlsx       -> Chennai, Dehradun, Jaipur, Mumbai stores
 *                                   (its Delhi rows are skipped: Delhi's stock
 *                                    is the Green Park file)
 *
 * Every quantity is booked as a RECEIVE movement ("Opening stock — <file>"),
 * so the stock ledger explains every number from day one. Re-running is safe:
 * each (store, item) opening movement has an idempotency key.
 *
 * What the files don't hold, and how it's handled — never guessed silently:
 *   - No unit costs: items start at ₹0 and Inventory flags them for pricing.
 *   - No SKUs: one is made from the item name (e.g. "AAM-PANNA-SYRUP").
 *   - Part-used bottles (0.75): stock is whole units, so they count as 1 and
 *     the exact figure is kept in the movement note.
 *   - Zero/negative quantities: skipped and listed.
 *   - Categories: Green Park's own sections; for the by-city file (which has
 *     none) a plain keyword match on the name, falling back to "Bar stock".
 *
 * Usage:  pnpm inventory:import            # dry run
 *         pnpm inventory:import --apply
 * Files are read from PODIUM_IMPORT_DIR (default: the user's Downloads).
 */
import * as path from "node:path";
import { prisma } from "@podium/db";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const DIR = process.env.PODIUM_IMPORT_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads");
const BY_CITY_FILE = "inventory-by-city.xlsx";
const GREEN_PARK_FILE = "GREEN PARK  INVENTORY.xlsx";
const IMPORTER = "nishant.kumar";

interface Row {
  city: string;
  name: string;
  qty: number;
  exact: number;
  unit: string | null;
  category: string;
  source: string;
}

// ------------------------------------------------------------ normalising

function cleanName(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim().replace(/[\s\-.,]+$/, "").trim();
  // Title-case names typed entirely in lower case; leave deliberate casing alone.
  if (s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s;
}

function parseQty(v: unknown): { qty: number; unit: string | null } | null {
  if (typeof v === "number") return { qty: v, unit: null };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/.exec(String(v ?? ""));
  if (!m) return null;
  return { qty: Number(m[1]), unit: m[2] ? m[2].toLowerCase().replace(/s$/, "") : null };
}

/** Plain keyword match for the by-city rows, which carry no category. */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/syrup|puree|pur[eé]e|cordial|monin/i, "Syrups"],
  [/bitters?\b|aperitivo|apertivo/i, "Bitters & aperitifs"],
  [/\bgin\b|\brum\b|whisk(e)?y|vodka|tequila|mezcal|brandy|liqueur|wine|beer/i, "Spirits & wine"],
  [/glass|tumbler|flute|coupe|highball|shot/i, "Glassware"],
  [/shaker|strainer|jigger|spoon|muddler|mat|pourer|tong|ice|bucket|opener|peeler|knife/i, "Bar tools"],
  [/apron|uniform|cap\b|hat\b/i, "Uniforms"],
  [/foam|gum|lecithin|acid|salt|sugar|powder|citric/i, "Consumables"],
  [/straw|napkin|stirrer|pick|tissue/i, "Disposables"],
];
const categoryFor = (name: string) => CATEGORY_RULES.find(([re]) => re.test(name))?.[1] ?? "Bar stock";

function sizeMlFrom(name: string): number | null {
  const ml = /(\d+(?:\.\d+)?)\s*ml\b/i.exec(name);
  if (ml) return Math.round(Number(ml[1]));
  const l = /(\d+(?:\.\d+)?)\s*(?:ltr|litre|liter|l)\b/i.exec(name);
  return l ? Math.round(Number(l[1]) * 1000) : null;
}

const unitFor = (name: string, explicit: string | null) =>
  explicit ?? (/syrup|puree|gin|rum|whisk|vodka|tequila|wine|bitter|aperitivo|apertivo|bottle|\d\s*ml|ltr/i.test(name) ? "bottle" : "unit");

function skuFor(name: string, taken: Set<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "ITEM";
  let sku = base;
  for (let i = 2; taken.has(sku); i++) sku = `${base}-${i}`;
  taken.add(sku);
  return sku;
}

// ----------------------------------------------------------------- reading

function readByCity(skipped: string[]): Row[] {
  const wb = XLSX.readFile(path.join(DIR, BY_CITY_FILE));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Inventory by City"]!, { defval: null });
  const out: Row[] = [];
  for (const r of rows) {
    const city = String(r.City ?? "").trim();
    const rawName = String(r["Item Name"] ?? "").trim();
    if (!city || !rawName) continue;
    if (/^delhi$/i.test(city)) continue; // Delhi = Green Park file
    const q = parseQty(r.Quantity);
    const name = cleanName(rawName);
    if (!q || q.qty <= 0) {
      skipped.push(`${city}: "${name}" quantity ${String(r.Quantity)}`);
      continue;
    }
    out.push({ city, name, qty: Math.ceil(q.qty), exact: q.qty, unit: q.unit, category: categoryFor(name), source: `${BY_CITY_FILE}` });
  }
  return out;
}

function readGreenPark(skipped: string[]): Row[] {
  const wb = XLSX.readFile(path.join(DIR, GREEN_PARK_FILE));
  const SHEET_CATEGORY: Array<[RegExp, string]> = [
    [/dry/i, "Dry drinks"],
    [/expir/i, "Expiry items"],
    [/lose|loose/i, "Loose items"],
  ];
  const out: Row[] = [];
  for (const sheet of wb.SheetNames) {
    let category = SHEET_CATEGORY.find(([re]) => re.test(sheet))?.[1] ?? "Bar stock";
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet]!, { header: 1, defval: null, blankrows: false });
    for (const r of grid) {
      const cells = r.filter((c) => c !== null && String(c).trim() !== "");
      if (cells.length === 0) continue;
      const first = String(cells[0]).trim();
      if (cells.length === 1) {
        // A single cell is a heading. "SYRUPS" opens a sub-section of the dry-drinks sheet.
        if (/^syrups?$/i.test(first)) category = "Syrups";
        continue;
      }
      if (/^items? name/i.test(first)) continue; // column header row
      const q = parseQty(cells[1]);
      const name = cleanName(first);
      if (!q || q.qty <= 0) {
        skipped.push(`Green Park / ${sheet.trim()}: "${name}" quantity ${String(cells[1])}`);
        continue;
      }
      out.push({ city: "Delhi", name, qty: Math.ceil(q.qty), exact: q.qty, unit: q.unit, category, source: `${GREEN_PARK_FILE} — ${sheet.trim()}` });
    }
  }
  return out;
}

// -------------------------------------------------------------------- main

async function main() {
  const skipped: string[] = [];
  const raw = [...readByCity(skipped), ...readGreenPark(skipped)];

  // Same item listed twice for one store -> one line, quantities added.
  const merged = new Map<string, Row & { notes: string[] }>();
  for (const r of raw) {
    const key = `${r.city.toLowerCase()}|${r.name.toLowerCase()}`;
    const prev = merged.get(key);
    const note = r.exact !== r.qty ? `part-used: ${r.exact}` : "";
    if (prev) {
      prev.qty += r.qty;
      prev.exact += r.exact;
      prev.notes.push(`listed twice in the file`, ...(note ? [note] : []));
    } else merged.set(key, { ...r, notes: note ? [note] : [] });
  }
  const lines = [...merged.values()];

  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  const cities = await prisma.city.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } });
  const cityId = (name: string) => cities.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id;
  const unknownCities = [...new Set(lines.map((l) => l.city))].filter((c) => !cityId(c));
  if (unknownCities.length) throw new Error(`Cities not in Podium: ${unknownCities.join(", ")}`);

  const importer = await prisma.user.findFirstOrThrow({ where: { username: IMPORTER }, select: { id: true } });
  const existingItems = await prisma.inventoryItem.findMany({ where: { workspaceId: workspace.id }, select: { id: true, sku: true, name: true } });
  const byName = new Map(existingItems.map((i) => [i.name.toLowerCase(), i]));
  const takenSkus = new Set(existingItems.map((i) => i.sku));

  // One catalogue item per distinct name, shared by every store that holds it.
  const newItems = new Map<string, { sku: string; name: string; category: string; unit: string; sizeMl: number | null }>();
  for (const l of lines) {
    const k = l.name.toLowerCase();
    if (byName.has(k) || newItems.has(k)) continue;
    newItems.set(k, { sku: skuFor(l.name, takenSkus), name: l.name, category: l.category, unit: unitFor(l.name, l.unit), sizeMl: sizeMlFrom(l.name) });
  }

  // ------------------------------------------------------------- report
  console.log(`${workspace.name} — reading ${DIR}`);
  const perCity = new Map<string, { lines: number; units: number }>();
  for (const l of lines) {
    const p = perCity.get(l.city) ?? { lines: 0, units: 0 };
    p.lines++;
    p.units += l.qty;
    perCity.set(l.city, p);
  }
  console.log("\nStock lines per store:");
  for (const [c, p] of perCity) console.log(`   ${(c === "Delhi" ? "Delhi (Green Park)" : c).padEnd(20)} ${String(p.lines).padStart(4)} items  ${String(p.units).padStart(5)} units`);
  console.log(`\nNew catalogue items: ${newItems.size} (already in Podium: ${lines.length && existingItems.length})`);
  const cats = new Map<string, number>();
  for (const i of newItems.values()) cats.set(i.category, (cats.get(i.category) ?? 0) + 1);
  console.log("By category:", [...cats.entries()].map(([c, n]) => `${c} ${n}`).join(" · "));
  const partUsed = lines.filter((l) => l.notes.some((n) => n.startsWith("part-used")));
  console.log(`\nPart-used, rounded up to whole units (${partUsed.length}):`);
  for (const l of partUsed) console.log(`   ${l.city}: ${l.name} — ${l.exact} -> ${l.qty}`);
  const doubles = lines.filter((l) => l.notes.includes("listed twice in the file"));
  if (doubles.length) console.log(`\nListed twice for the same store, added together: ${doubles.map((l) => `${l.city}: ${l.name} = ${l.qty}`).join("; ")}`);
  console.log(`\nSkipped (${skipped.length}):`);
  for (const s of skipped) console.log(`   ${s}`);

  if (!APPLY) return console.log("\nDry run — nothing was written. Re-run with --apply.");

  // --------------------------------------------------------------- write
  // Stores: Delhi's is Green Park; the rest are "<City> store".
  const storeFor = new Map<string, string>();
  for (const cityName of perCity.keys()) {
    const cid = cityId(cityName)!;
    const existing = await prisma.inventoryLocation.findFirst({ where: { cityId: cid, deletedAt: null } });
    const loc =
      existing ??
      (await prisma.inventoryLocation.create({ data: { cityId: cid, name: cityName.toLowerCase() === "delhi" ? "Green Park (Delhi)" : `${cityName} store` } }));
    storeFor.set(cityName, loc.id);
  }

  if (newItems.size) {
    await prisma.inventoryItem.createMany({
      data: [...newItems.values()].map((i) => ({ workspaceId: workspace.id, sku: i.sku, name: i.name, category: i.category, unit: i.unit, sizeMl: i.sizeMl, standardCost: 0 })),
      skipDuplicates: true,
    });
  }
  const items = await prisma.inventoryItem.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } });
  const itemId = new Map(items.map((i) => [i.name.toLowerCase(), i.id]));

  const keyFor = (l: Row) => `opening:${storeFor.get(l.city)}:${itemId.get(l.name.toLowerCase())}`;
  const done = new Set(
    (await prisma.inventoryMovement.findMany({ where: { idempotencyKey: { in: lines.map(keyFor) } }, select: { idempotencyKey: true } })).map((m) => m.idempotencyKey),
  );
  const todo = lines.filter((l) => !done.has(keyFor(l)));

  // Opening balances. Fresh (store, item) pairs are created in one statement;
  // a pair that already has stock gets the opening quantity added.
  const existingBalances = await prisma.inventoryBalance.findMany({
    where: { locationId: { in: [...storeFor.values()] } },
    select: { skuId: true, locationId: true },
  });
  const hasBalance = new Set(existingBalances.map((b) => `${b.locationId}:${b.skuId}`));
  const fresh = todo.filter((l) => !hasBalance.has(`${storeFor.get(l.city)}:${itemId.get(l.name.toLowerCase())}`));
  const topUp = todo.filter((l) => hasBalance.has(`${storeFor.get(l.city)}:${itemId.get(l.name.toLowerCase())}`));

  await prisma.$transaction(
    async (tx) => {
      await tx.inventoryBalance.createMany({
        data: fresh.map((l) => ({ skuId: itemId.get(l.name.toLowerCase())!, locationId: storeFor.get(l.city)!, qtyOnHand: l.qty, reorderLevel: 0 })),
      });
      for (const l of topUp) {
        await tx.inventoryBalance.update({
          where: { skuId_locationId: { skuId: itemId.get(l.name.toLowerCase())!, locationId: storeFor.get(l.city)! } },
          data: { qtyOnHand: { increment: l.qty } },
        });
      }
      await tx.inventoryMovement.createMany({
        data: todo.map((l) => ({
          skuId: itemId.get(l.name.toLowerCase())!,
          type: "RECEIVE" as const,
          toLocationId: storeFor.get(l.city)!,
          qty: l.qty,
          actorId: importer.id,
          refType: "opening_stock",
          note: [`Opening stock — ${l.source}`, ...l.notes].join(" · "),
          idempotencyKey: keyFor(l),
        })),
      });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: importer.id,
          action: "inventory.opening_stock_imported",
          entityType: "workspace",
          entityId: workspace.id,
          after: { files: [BY_CITY_FILE, GREEN_PARK_FILE], items: newItems.size, lines: todo.length, skipped: skipped.length },
        },
      });
    },
    { maxWait: 20_000, timeout: 120_000 },
  );

  console.log(`\nWritten: ${newItems.size} items, ${todo.length} opening-stock movements (${lines.length - todo.length} already imported).`);
  const check = await prisma.inventoryBalance.groupBy({ by: ["locationId"], _sum: { qtyOnHand: true }, _count: { _all: true } });
  const locs = await prisma.inventoryLocation.findMany({ select: { id: true, name: true } });
  for (const c of check) console.log(`   ${locs.find((l) => l.id === c.locationId)?.name.padEnd(20)} ${c._count._all} items, ${c._sum.qtyOnHand} units`);
}

main()
  .catch((e) => {
    console.error(String(e).split("\n").slice(0, 3).join("\n"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
