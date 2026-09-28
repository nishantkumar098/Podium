/**
 * Podium v2 — import "Vendor's Database.xlsx" into the Vendor table.
 *
 * This is a SEPARATE workbook from the one `import-real-data.ts` already
 * consumes (that one reads a sheet called "Clients" inside
 * AMM_BRANDS_LLP_DATABASE.xlsx, mislabeled but actually the supplier list).
 * "Vendor's Database.xlsx" is a different, newer per-city vendor workbook
 * with its own sheet layouts, so it gets its own importer rather than being
 * bolted onto the existing one.
 *
 * Sheets and what's actually in them (checked against the real file before
 * writing this):
 *   - "Vendor Database"           786 named rows across cities (mostly Chennai and Delhi, per each row's City cell),
 *                                  each with a real Vendor ID (e.g. "DEL-GLS-025")
 *   - "DELHI"                     148 named rows, no per-row city (falls back
 *                                  to sheet name), no Vendor ID
 *   - "MUMBAI"                    522 named rows, per-row city filled
 *   - "DEHRADUN"                   37 named rows (mostly blank category
 *                                  placeholders otherwise — skipped by the
 *                                  "must have a name" filter, not hardcoded)
 *   - "JAIPUR" / "CHENNAI"          2 named rows each — same story
 *   - "Rajasthan vendor planners" ~190 rows, entirely different layout
 *                                  (company name / address / hours / mobile /
 *                                  website) — event planners, not suppliers
 *
 * Every sheet is read through the SAME generic header-based column lookup
 * (see `col()`), so a sheet's differing column names/order doesn't need
 * special-casing — only "Rajasthan vendor planners" gets its own column
 * aliases, because its headers don't overlap with the others at all.
 *
 * Idempotent: every row's externalRef is
 *   - `VENDORDB:<Vendor ID>` when the sheet gives a real one (the master
 *     "Vendor Database" sheet), or
 *   - `VENDORDB:<sheet name>:<row index>` otherwise,
 * enforced by the existing `@@unique([workspaceId, externalRef])` on Vendor.
 * Re-running against the same file inserts zero new rows.
 *
 * Cross-sheet duplicates (the same vendor appearing in both "DELHI" and
 * "Vendor Database", say) are NOT auto-merged — there's no reliable key
 * shared across sheets to merge on, and silently merging two rows that only
 * happen to share a phone number risks conflating two different vendors.
 * Instead, exact phone matches across sheets are logged in the report so a
 * human can review and merge by hand if needed.
 *
 * SECURITY: sheet names and column headers are still checked against
 * forbidden-sheet.ts's patterns before anything is read, even though this
 * workbook is not expected to carry credentials/salary/bank/government-ID
 * data — same discipline as every other importer in this repo, not a
 * one-off exception.
 *
 * Usage:
 *   pnpm import:vendor-database --dry-run
 *   pnpm import:vendor-database
 */
import * as path from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { isForbiddenSheet, blockedColumnsIn } from "./forbidden-sheet";
import { normalizePhone } from "./import-real-data";

const prisma = new PrismaClient();

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads";
const VENDOR_FILE = path.join(UPLOADS, process.env.PODIUM_VENDOR_FILE ?? "Vendor's Database.xlsx");

const DRY_RUN = process.argv.includes("--dry-run");
/**
 * --fix-cities: only fill in the city of vendors already imported without
 * one. Touches no other field, so edits made in Podium since the import
 * (status, rating, contacts) are never overwritten.
 */
const FIX_CITIES = process.argv.includes("--fix-cities");
const CHUNK = 500;

// =========================================================================
// City matching — same alias table as import-real-data.ts (AMM operates in
// these six cities only; anything else stays free text, never guessed).
// =========================================================================

const CITY_ALIASES: Record<string, string[]> = {
  JPR: ["jaipur"],
  DEL: ["delhi", "new delhi", "delhi ncr", "ncr"],
  BOM: ["mumbai", "bombay"],
  GOA: ["goa"],
  DDN: ["dehradun", "dehra dun"],
  MAA: ["chennai", "madras"],
};

function buildCityMatcher(cities: { id: string; code: string }[]) {
  const byAlias = new Map<string, string>();
  for (const city of cities) {
    for (const alias of CITY_ALIASES[city.code] ?? []) byAlias.set(alias, city.id);
  }
  return (text: string | null): string | null => {
    if (!text) return null;
    const cleaned = text.toLowerCase().trim();
    return byAlias.get(cleaned) ?? null;
  };
}

// =========================================================================
// Sheet-reading helpers (same shape as import-real-data.ts, kept local so
// this script has no non-exported dependency on that one)
// =========================================================================

type Row = (string | number | null)[];
const normName = (s: string) => String(s).replace(/\s+/g, " ").trim().toUpperCase();

function col(header: Row, candidates: string[]): number {
  for (const candidate of candidates) {
    const i = header.findIndex((h) => h !== null && normName(String(h)) === normName(candidate));
    if (i !== -1) return i;
  }
  return -1;
}

function cell(row: Row, index: number): string | null {
  if (index < 0) return null;
  const v = row[index];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Column name aliases. Covers every header text actually seen across the
// sheets — see the sheet-by-sheet notes at the top of this file.
const VENDOR_ID_COLS = ["Vendor ID"];
const CITY_COLS = ["City"];
const CATEGORY_COLS = ["Vendor Category"];
const NAME_COLS = ["Vendor Name", "company Name"];
const CONTACT_PERSON_COLS = ["Contact Person"];
// "Contect no" (sic) is DELHI's own phone column, not a contact-person name.
const PHONE_COLS = ["Mobile", "Contect no", "Moblie No"];
const WHATSAPP_COLS = ["WhatsApp"];
const EMAIL_COLS = ["Email"];
const PRODUCT_COLS = ["PRODUCT/SERVICE"];
const PRICING_COLS = ["PRICING(IF APPLICABLE)"];
const DELIVERY_COLS = ["DELIVERY TIME"];
const MIN_ORDER_COLS = ["MINIMUM ORDER"];
const GST_COLS = ["GST (IF APPLICABLE)"];
const CREDIT_COLS = ["CREDIT TERMS(IF APPLICABLE)"];
const REMARK_COLS = ["REMARK"];
// "Rajasthan vendor planners" only — no overlap with the vendor-sheet columns.
const PLANNER_ADDRESS_COLS = ["city & Address"];
const PLANNER_HOURS_COLS = ["working Hours"];
const PLANNER_WEBSITE_COLS = ["website", "Url"];

interface ParsedVendor {
  externalRef: string;
  name: string;
  category: string | null;
  cityText: string | null;
  cityId: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  phoneRaw: string | null;
  address: string | null;
  source: string;
}

/** Builds a compact, labeled notes string from whatever operational columns
 * a row has — this workbook has no separate street-address field for most
 * sheets, and Vendor has no notes/remarks column, so this is where pricing,
 * delivery time, minimum order, GST and remark text end up. Only non-empty
 * parts are included. */
function buildNotes(row: Row, header: Row): string | null {
  const parts: string[] = [];
  const add = (label: string, cols: string[]) => {
    const v = cell(row, col(header, cols));
    if (v) parts.push(`${label}: ${v}`);
  };
  add("Product/Service", PRODUCT_COLS);
  add("Pricing", PRICING_COLS);
  add("Delivery", DELIVERY_COLS);
  add("Min order", MIN_ORDER_COLS);
  add("GST", GST_COLS);
  add("Credit terms", CREDIT_COLS);
  add("Remark", REMARK_COLS);
  return parts.length ? parts.join(" | ") : null;
}

function parseVendorSheet(
  sheetName: string,
  grid: Row[],
  matchCity: (text: string | null) => string | null,
): { rows: ParsedVendor[]; stats: Record<string, number> } {
  const header = grid[0] ?? [];
  const nameIdx = col(header, NAME_COLS);
  const stats = { rawRows: grid.length - 1, noName: 0, headerRepeat: 0, imported: 0 };
  if (nameIdx === -1) return { rows: [], stats }; // sheet layout not recognized — skip, don't guess

  const blocked = blockedColumnsIn(grid, 3);
  const rows: ParsedVendor[] = [];

  for (const [rowIdx, row] of grid.slice(1).entries()) {
    const name = cell(row, nameIdx);
    if (!name) {
      stats.noName++;
      continue;
    }
    // A repeated header row in the middle of the sheet (e.g. "Vendor
    // Database"'s header reprints every ~100 rows) reads its own column
    // label back as the "name" — catch that rather than importing it.
    if (normName(name) === normName(NAME_COLS[0]!) || normName(name) === "COMPANY NAME") {
      stats.headerRepeat++;
      continue;
    }

    const vendorId = cell(row, col(header, VENDOR_ID_COLS));
    const cityText = cell(row, col(header, CITY_COLS)) ?? sheetName;
    const { phone, phoneRaw } = normalizePhone(
      cell(row, col(header, PHONE_COLS)) ?? cell(row, col(header, WHATSAPP_COLS)),
    );

    rows.push({
      externalRef: vendorId ? `VENDORDB:${vendorId}` : `VENDORDB:${sheetName}:${rowIdx}`,
      name,
      category: cell(row, col(header, CATEGORY_COLS)),
      cityText,
      // Some sheets (DEHRADUN) put contact names in their "City" column; when
      // the cell is not a known city, the sheet itself names the city.
      cityId: matchCity(cityText) ?? matchCity(sheetName),
      contactName: cell(row, col(header, CONTACT_PERSON_COLS)),
      email: blocked.indices.has(col(header, EMAIL_COLS)) ? null : cell(row, col(header, EMAIL_COLS)),
      phone,
      phoneRaw,
      address: buildNotes(row, header),
      source: `Vendor's Database.xlsx — sheet "${sheetName}"`,
    });
    stats.imported++;
  }
  return { rows, stats };
}

function parsePlannerSheet(grid: Row[]): { rows: ParsedVendor[]; stats: Record<string, number> } {
  const header = grid[0] ?? [];
  const nameIdx = col(header, ["company Name"]);
  const stats = { rawRows: grid.length - 1, noName: 0, imported: 0 };
  const rows: ParsedVendor[] = [];

  for (const [rowIdx, row] of grid.slice(1).entries()) {
    const name = cell(row, nameIdx);
    if (!name) {
      stats.noName++;
      continue;
    }
    const { phone, phoneRaw } = normalizePhone(cell(row, col(header, ["Moblie No"])));
    const address = cell(row, col(header, PLANNER_ADDRESS_COLS));
    const hours = cell(row, col(header, PLANNER_HOURS_COLS));
    const website = cell(row, col(header, PLANNER_WEBSITE_COLS));
    rows.push({
      externalRef: `VENDORDB:Rajasthan vendor planners:${rowIdx}`,
      name,
      category: "Event Planner",
      cityText: "Rajasthan",
      cityId: null, // "Rajasthan" isn't one of AMM's six operating cities — left unmatched rather than guessed
      contactName: null,
      email: null,
      phone,
      phoneRaw,
      address: [address, hours ? `Hours: ${hours}` : null, website ? `Website: ${website}` : null]
        .filter(Boolean)
        .join(" | ") || null,
      source: `Vendor's Database.xlsx — sheet "Rajasthan vendor planners"`,
    });
    stats.imported++;
  }
  return { rows, stats };
}

// =========================================================================

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}IMPORT VENDOR DATABASE — ${dbName}`);
  console.log(`${"=".repeat(72)}`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");
  const cities = await prisma.city.findMany({ select: { id: true, code: true } });
  const matchCity = buildCityMatcher(cities);

  const sheetNames: string[] = XLSX.readFile(VENDOR_FILE, { bookSheets: true }).SheetNames;
  const refused = sheetNames.filter(isForbiddenSheet);
  const allowed = sheetNames.filter((n) => !isForbiddenSheet(n));
  if (refused.length) console.log(`\nREFUSED SHEETS (forbidden pattern matched): ${refused.join(", ")}`);
  const wb = XLSX.readFile(VENDOR_FILE, { sheets: allowed, cellDates: true });

  const allRows: ParsedVendor[] = [];
  const report: Record<string, unknown> = {};

  for (const sheetName of allowed) {
    const grid = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName]!, { header: 1, defval: null, blankrows: false });
    const { rows, stats } =
      sheetName === "Rajasthan vendor planners" ? parsePlannerSheet(grid) : parseVendorSheet(sheetName, grid, matchCity);
    report[sheetName] = stats;
    console.log(`${sheetName.padEnd(28)} ${JSON.stringify(stats)}`);
    allRows.push(...rows);
  }

  // Cross-sheet phone collisions — reported, not auto-merged (see file header).
  const byPhone = new Map<string, ParsedVendor[]>();
  for (const r of allRows) {
    if (!r.phone) continue;
    (byPhone.get(r.phone) ?? byPhone.set(r.phone, []).get(r.phone)!).push(r);
  }
  const crossSheetDupes = [...byPhone.entries()].filter(([, rs]) => new Set(rs.map((r) => r.source)).size > 1);
  console.log(`\nCross-sheet phone collisions (review manually, not auto-merged): ${crossSheetDupes.length}`);
  for (const [phone, rs] of crossSheetDupes.slice(0, 20)) {
    console.log(`   ${phone}: ${rs.map((r) => `"${r.name}" (${r.source.split('"')[1]})`).join("  <->  ")}`);
  }

  console.log(`\nTOTAL importable rows: ${allRows.length}`);

  if (DRY_RUN) {
    console.log("\nSample:");
    for (const r of allRows.slice(0, 5)) {
      console.log(`   ${r.name.slice(0, 32).padEnd(32)} ${(r.category ?? "—").slice(0, 20).padEnd(20)} ${r.phone ?? "—"}  ${r.cityText ?? "—"}`);
    }
    console.log("\nDry run — nothing was written.");
    return;
  }

  if (FIX_CITIES) {
    // One update per city, not per row — each row is a round trip to the database.
    const refsByCity = new Map<string, string[]>();
    for (const r of allRows) if (r.cityId) refsByCity.set(r.cityId, [...(refsByCity.get(r.cityId) ?? []), r.externalRef]);
    let fixed = 0;
    for (const [cityId, refs] of refsByCity) {
      const res = await prisma.vendor.updateMany({
        where: { workspaceId: workspace.id, externalRef: { in: refs }, cityId: null },
        data: { cityId },
      });
      fixed += res.count;
    }
    console.log(`
Cities filled in: ${fixed}`);
    return;
  }

  let written = 0;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const slice = allRows.slice(i, i + CHUNK);
    await prisma.$transaction(
      slice.map((r) => {
        const data: Prisma.VendorUncheckedCreateInput = {
          workspaceId: workspace.id,
          externalRef: r.externalRef,
          name: r.name,
          category: r.category,
          cityId: r.cityId,
          contactName: r.contactName,
          email: r.email,
          phone: r.phone,
          phoneRaw: r.phoneRaw,
          address: r.address,
          source: r.source,
          status: "APPROVED",
        };
        const { workspaceId: _w, externalRef: _e, ...update } = data;
        return prisma.vendor.upsert({
          where: { workspaceId_externalRef: { workspaceId: workspace.id, externalRef: r.externalRef } },
          create: data,
          update,
        });
      }),
    );
    written += slice.length;
  }

  console.log(`\nWritten this run: ${written}`);
  console.log(`Vendors now in ${dbName}: ${await prisma.vendor.count({ where: { workspaceId: workspace.id } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());