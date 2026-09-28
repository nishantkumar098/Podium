/**
 * Podium v2 — import the sellable catalogue for both AMM trading brands.
 *
 *   products.json          → Elixir Coterie  (510 rows; event bar, hookah,
 *                            chai adda, culinary, tuck shop, customization)
 *   The_Cocktail_Shop.xlsx → The Cocktail Shop (1,383 rows; retail product
 *                            with SKU, HSN, GST rate and supplier)
 *
 * Additive and idempotent, like the client importer: every row is keyed on a
 * deterministic `externalRef` behind a real `@@unique([workspaceId,
 * externalRef])`, so re-running against the same file updates in place and
 * inserts nothing new. The Elixir export carries MongoDB `_id`s, which make
 * a better key than a row index because the source can be re-ordered.
 *
 * Usage:
 *   pnpm import:products --dry-run
 *   pnpm import:products
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { blockedKeysIn, isForbiddenSheet } from "./forbidden-sheet";

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";
const ELIXIR_PRODUCTS = path.join(UPLOADS, process.env.PODIUM_ELIXIR_PRODUCTS ?? "4565ce3a-products.json");
const TCS_PRODUCTS = path.join(UPLOADS, process.env.PODIUM_TCS_PRODUCTS ?? "9d3bd165-The_Cocktail_Shop.xlsx");

const DRY_RUN = process.argv.includes("--dry-run");
const CHUNK = 500;

const prisma = new PrismaClient();

const BRANDS = [
  { code: "ELIXIR", name: "Elixir Coterie", tagline: "Event bar, hookah & culinary", website: "elixircoterie.com" },
  { code: "TCS", name: "The Cocktail Shop", tagline: "Bar retail & barware", website: "thecocktailshop.in" },
];

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

type PricingMode = "PER_QUANTITY" | "PER_GUEST" | "FIXED";
const PRICING: Record<string, PricingMode> = {
  per_quantity: "PER_QUANTITY",
  per_guest: "PER_GUEST",
  fixed: "FIXED",
};

interface Row {
  externalRef: string;
  sku: string | null;
  name: string;
  serviceLine: string | null;
  category: string | null;
  shortDesc: string | null;
  longDesc: string | null;
  unit: string | null;
  price: number;
  pricingMode: PricingMode;
  gstRate: number | null;
  hsnSac: string | null;
  isActive: boolean;
  stockQty: number | null;
  vendorName: string | null;
  sourceFlag: string | null;
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Elixir Coterie — products.json
// ---------------------------------------------------------------------------

interface ElixirProduct {
  _id?: { $oid?: string };
  serviceId?: string;
  category?: string;
  name?: string;
  shortDesc?: string;
  longDesc?: string;
  pricingMode?: string;
  price?: number;
  isVisible?: boolean;
  hasVariants?: boolean;
  variantOptions?: Array<{ label?: string; priceDelta?: number }>;
}

function readElixir(): { rows: Row[]; stats: Record<string, number> } {
  const raw = JSON.parse(fs.readFileSync(ELIXIR_PRODUCTS, "utf8")) as ElixirProduct[];
  const rows: Row[] = [];
  const stats = { rawRows: raw.length, noName: 0, noId: 0, withVariants: 0, hidden: 0 };
  const seen = new Set<string>();

  for (const [index, p] of raw.entries()) {
    const name = text(p.name);
    if (!name) {
      stats.noName++;
      continue;
    }
    // The Mongo _id is the stable key. Falling back to the array index would
    // re-key every row the moment the export is re-sorted, so a missing _id
    // is counted and keyed by name instead.
    const oid = text(p._id?.$oid);
    if (!oid) stats.noId++;
    let ref = `ELIXIR:${oid ?? `name:${name.toUpperCase()}`}`;
    if (seen.has(ref)) ref = `${ref}#${index}`;
    seen.add(ref);

    if (p.hasVariants) stats.withVariants++;
    if (p.isVisible === false) stats.hidden++;

    // Variants carry a price delta off the base. Podium has no variant model,
    // so rather than silently dropping them or inventing a product per
    // variant, the labels are appended to the description where a human can
    // see them and price accordingly.
    const variants = (p.variantOptions ?? [])
      .map((v) => {
        const label = text(v.label);
        return label ? `${label}${v.priceDelta ? ` (+₹${v.priceDelta})` : ""}` : null;
      })
      .filter(Boolean);

    rows.push({
      externalRef: ref,
      sku: null,
      name,
      serviceLine: text(p.serviceId),
      category: text(p.category),
      shortDesc: text(p.shortDesc),
      longDesc: [text(p.longDesc), variants.length ? `Variants: ${variants.join(", ")}` : null].filter(Boolean).join(" — ") || null,
      unit: null,
      price: num(p.price) ?? 0,
      pricingMode: PRICING[String(p.pricingMode)] ?? "PER_QUANTITY",
      // The Elixir export files no GST rate; it is not invented here.
      gstRate: null,
      hsnSac: null,
      isActive: p.isVisible !== false,
      stockQty: null,
      vendorName: null,
      sourceFlag: null,
      sourceFile: path.basename(ELIXIR_PRODUCTS),
    });
  }
  return { rows, stats };
}

// ---------------------------------------------------------------------------
// The Cocktail Shop — Master Product List
// ---------------------------------------------------------------------------

function readCocktailShop(): { rows: Row[]; stats: Record<string, number>; excluded: string[] } {
  const sheetNames: string[] = XLSX.readFile(TCS_PRODUCTS, { bookSheets: true }).SheetNames;
  const refused = sheetNames.filter(isForbiddenSheet);
  const allowed = sheetNames.filter((n) => !isForbiddenSheet(n));
  const book = XLSX.readFile(TCS_PRODUCTS, { sheets: allowed, cellDates: true });

  const sheet = allowed.find((n) => /MASTER PRODUCT LIST/i.test(n));
  if (!sheet) throw new Error(`no "Master Product List" sheet in ${path.basename(TCS_PRODUCTS)}`);

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[sheet]!, { defval: null });
  const excluded = [...refused.map((r) => `sheet "${r}"`)];
  // Checks the heading row wherever it actually is — see blockedKeysIn.
  const { keys: blocked, matches } = blockedKeysIn(raw, 3);
  for (const m of matches) excluded.push(`column "${m.key}" (heading "${m.text}") [${m.category}]`);
  const pick = (r: Record<string, unknown>, key: string) => (blocked.has(key) ? null : r[key]);

  const rows: Row[] = [];
  const stats = { rawRows: raw.length, noName: 0, dupSku: 0, noPrice: 0, flagged: 0 };
  const seen = new Set<string>();

  for (const [index, r] of raw.entries()) {
    const name = text(pick(r, "Product Name"));
    if (!name) {
      stats.noName++;
      continue;
    }
    const sku = text(pick(r, "s"));

    // The sheet's own "ITEM CODE (flag)" column already warns that some codes
    // are shared between rows, so the SKU alone is not a safe key. Fall back
    // to the row index for those rather than collapsing two real products.
    let ref = sku ? `TCS:${sku}` : `TCS:row:${index}`;
    if (seen.has(ref)) {
      stats.dupSku++;
      ref = `TCS:row:${index}`;
    }
    seen.add(ref);

    // "Selling Price (excl GST)" is the invoice-relevant figure. Trade Price
    // is what AMM pays, not what it charges.
    const price = num(pick(r, "Selling Price (excl GST)")) ?? num(pick(r, "Trade Price")) ?? 0;
    if (price === 0) stats.noPrice++;

    const flag = text(pick(r, "ITEM CODE (flag)"));
    if (flag) stats.flagged++;

    rows.push({
      externalRef: ref,
      sku,
      name,
      serviceLine: text(pick(r, "Product Type")),
      category: text(pick(r, "Category")),
      shortDesc: text(pick(r, "Capacity/Volume/Weight")),
      longDesc: text(pick(r, "Link")),
      unit: text(pick(r, "Unit")),
      price,
      pricingMode: "PER_QUANTITY",
      gstRate: num(pick(r, "GST %")),
      hsnSac: text(pick(r, "HSN Code")),
      // The Status column is empty on every row in this export, so "active"
      // is the only defensible reading — an all-blank column is not evidence
      // that 1,383 products are discontinued.
      isActive: true,
      stockQty: num(pick(r, "Stock Quantity")),
      vendorName: text(pick(r, "Vendor / Supplier Name")),
      sourceFlag: flag,
      sourceFile: path.basename(TCS_PRODUCTS),
    });
  }
  return { rows, stats, excluded };
}

// ---------------------------------------------------------------------------

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}IMPORT PRODUCTS — ${dbName}`);
  console.log(`${"=".repeat(72)}`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");

  const elixir = readElixir();
  const tcs = readCocktailShop();

  console.log(`\nSENSITIVE EXCLUSIONS (The Cocktail Shop): ${tcs.excluded.length ? tcs.excluded.join(", ") : "none matched"}`);
  console.log(`\nElixir Coterie  : ${elixir.stats.rawRows} raw → ${elixir.rows.length} importable  ${JSON.stringify(elixir.stats)}`);
  console.log(`The Cocktail Shop: ${tcs.stats.rawRows} raw → ${tcs.rows.length} importable  ${JSON.stringify(tcs.stats)}`);

  if (DRY_RUN) {
    for (const [label, rows] of [["ELIXIR", elixir.rows], ["TCS", tcs.rows]] as const) {
      console.log(`\n${label} sample:`);
      for (const r of rows.slice(0, 3)) {
        console.log(`   ${(r.sku ?? "—").padEnd(12)} ${r.name.slice(0, 38).padEnd(38)} ${String(r.price).padStart(9)}  ${r.category ?? "—"}`);
      }
    }
    console.log(`\nDry run — nothing was written.`);
    return;
  }

  const brandIds = new Map<string, string>();
  for (const b of BRANDS) {
    const brand = await prisma.brand.upsert({
      where: { workspaceId_code: { workspaceId: workspace.id, code: b.code } },
      create: { workspaceId: workspace.id, code: b.code, name: b.name, tagline: b.tagline, website: b.website },
      update: { name: b.name, tagline: b.tagline, website: b.website },
    });
    brandIds.set(b.code, brand.id);
  }

  let written = 0;
  for (const [code, rows] of [["ELIXIR", elixir.rows], ["TCS", tcs.rows]] as const) {
    const brandId = brandIds.get(code)!;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await prisma.$transaction(
        slice.map((r) => {
          const data: Prisma.ProductUncheckedCreateInput = {
            workspaceId: workspace.id,
            brandId,
            externalRef: r.externalRef,
            sku: r.sku,
            name: r.name,
            serviceLine: r.serviceLine,
            category: r.category,
            shortDesc: r.shortDesc,
            longDesc: r.longDesc,
            unit: r.unit,
            price: r.price,
            pricingMode: r.pricingMode,
            gstRate: r.gstRate,
            hsnSac: r.hsnSac,
            isActive: r.isActive,
            stockQty: r.stockQty,
            vendorName: r.vendorName,
            sourceFlag: r.sourceFlag,
            sourceFile: r.sourceFile,
          };
          const { workspaceId: _w, externalRef: _e, ...update } = data;
          return prisma.product.upsert({
            where: { workspaceId_externalRef: { workspaceId: workspace.id, externalRef: r.externalRef } },
            create: data,
            update,
          });
        }),
      );
      written += slice.length;
    }
    console.log(`\n${code}: ${rows.length} row(s) written`);
  }

  const counts = await prisma.product.groupBy({ by: ["brandId"], _count: { _all: true } });
  console.log(`\nVERIFY — products now in ${dbName}:`);
  for (const b of BRANDS) {
    const id = brandIds.get(b.code)!;
    const n = counts.find((c) => c.brandId === id)?._count._all ?? 0;
    console.log(`   ${b.name.padEnd(20)} ${String(n).padStart(6)}`);
  }
  console.log(`   ${"TOTAL".padEnd(20)} ${String(await prisma.product.count()).padStart(6)}   (written this run: ${written})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
