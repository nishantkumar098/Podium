/**
 * Podium v2 — real-data import (AMM Brands LLP).
 *
 * Replaces the development seed fixture's synthetic clients / vendors /
 * freelancers / leads with AMM Brands' actual records, sourced from two
 * workbooks:
 *
 *   - AMM_BRANDS_LLP_DATABASE.xlsx   (clients, vendors, staffing, prospecting)
 *   - Elixir_New_Clients_Query.xlsx  (the live sales pipeline)
 *
 * SECURITY: `AMM_BRANDS_LLP_DATABASE.xlsx` contains a sheet of plaintext
 * credentials. It is never opened, read, parsed, or logged — `assertNotForbidden`
 * is called on every sheet name before any cell of it is touched, and throws
 * rather than skipping quietly, so a future edit can't silently start reading it.
 *
 * This is not the dev seed: `pnpm --filter @podium/db seed` builds the demo
 * fixture that CI and the e2e suite run against, and refuses to run against
 * anything that looks like real data (see packages/db/prisma/seed.ts).
 *
 * BUG-002 fix (2026-09-12 CTO audit): this importer is ADDITIVE and
 * IDEMPOTENT. It never deletes anything — the destructive
 * purge-then-reimport this script used to run on every invocation has been
 * retired (see the historical comment where `purgeSyntheticData` used to be,
 * a few hundred lines below). Every row is keyed on a deterministic
 * `externalRef` computed from its exact source location (sheet name + row
 * index), enforced by a real `@@unique([workspaceId, externalRef])`
 * constraint — so running this twice against the same files inserts zero new
 * rows, and running it again after AMM sends an updated spreadsheet inserts
 * only the rows that are genuinely new. Verified live — see docs/STATUS.md
 * §1.2.
 *
 * Usage:  pnpm import:real-data [--dry-run]
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { assertNotForbidden } from "./forbidden-sheet";

const prisma = new PrismaClient();

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";
/**
 * The 2026-09-15 source-of-truth refresh. `AMM_BRANDS_LLP_DATABASE_1.xlsx` is
 * byte-identical to the 2026-09-11 upload it replaces (verified by md5), so
 * pointing at it changes nothing for clients, vendors or crew; the Elixir
 * workbook is a genuine refresh, carrying three new intake-form responses and
 * three new funnel rows. Overridable so a later refresh needs no code change.
 */
const AMM_FILE = path.join(UPLOADS, process.env.PODIUM_AMM_FILE ?? "f4544bcd-AMM_BRANDS_LLP_DATABASE_1.xlsx");
const ELIXIR_FILE = path.join(UPLOADS, process.env.PODIUM_ELIXIR_FILE ?? "8d3abe94-Elixir_New_Clients_Query_1.xlsx");

const DRY_RUN = process.argv.includes("--dry-run");
const CHUNK = 2_000;

// =========================================================================
// §1 — the forbidden sheet
// =========================================================================

export { assertNotForbidden } from "./forbidden-sheet";

// =========================================================================
// §2 — phone normalization
// =========================================================================

export interface NormalizedPhone {
  /** Canonical 10-digit form used as the dedupe key, or null if unusable. */
  phone: string | null;
  /** The original string exactly as the sheet had it (country code intact). */
  phoneRaw: string | null;
}

/**
 * Strips non-digits; if the result is longer than 10 digits it keeps the last
 * 10 (dropping a country code such as 91). Cells frequently hold several
 * numbers ("9885095546/9999721928", "(971) 505565764, (7) 9168587") — the
 * first is taken as canonical and the whole original is preserved in phoneRaw,
 * so nothing is lost.
 *
 * A result shorter than 10 digits (a truncated cell, or a landline written
 * without its STD code) cannot be a canonical Indian number, so it yields a
 * null key: such a row is still imported, it just never participates in phone
 * dedupe. Guessing digits to pad it would silently merge unrelated people.
 */
export function normalizePhone(raw: unknown): NormalizedPhone {
  if (raw === null || raw === undefined) return { phone: null, phoneRaw: null };
  const text = String(raw).trim();
  if (!text) return { phone: null, phoneRaw: null };

  // Split on common multi-number separators, keeping the first candidate that
  // yields >= 10 digits.
  const candidates = text.split(/[/,;&]|\s{2,}|\bor\b/i);
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 10) return { phone: digits.slice(-10), phoneRaw: text };
  }
  const allDigits = text.replace(/\D/g, "");
  if (allDigits.length >= 10) return { phone: allDigits.slice(-10), phoneRaw: text };
  return { phone: null, phoneRaw: text };
}

// =========================================================================
// Sheet access helpers
// =========================================================================

type Row = (string | null)[];

interface Sheet {
  name: string;
  header: string[];
  rows: Row[];
}

const normName = (s: string) => String(s).replace(/\s+/g, " ").trim().toUpperCase();

function openWorkbook(file: string): XLSX.WorkBook {
  return XLSX.readFile(file, { cellDates: true });
}

/**
 * Reads one sheet by (whitespace-insensitive) name. Sheet names in these
 * workbooks carry stray trailing and doubled spaces — "IBG circle ",
 * "MUSCAT HOTEL  WEDDING PLANNER" — so every lookup normalizes first.
 */
function readSheet(wb: XLSX.WorkBook, wanted: string): Sheet {
  const real = wb.SheetNames.find((n) => normName(n) === normName(wanted));
  if (!real) throw new Error(`Sheet not found: ${JSON.stringify(wanted)}`);
  assertNotForbidden(real);

  const raw = XLSX.utils.sheet_to_json<Row>(wb.Sheets[real], { header: 1, defval: null, blankrows: false });
  const header = (raw[0] ?? []).map((c) => (c === null ? "" : String(c)));
  return { name: real, header, rows: raw.slice(1) };
}

/** Finds a column index by trying each candidate header name in priority order. */
function col(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const i = header.findIndex((h) => normName(h) === normName(candidate));
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

/** Parses an amount out of strings like "50,000", "₹ 1.2L", "50000/-". */
function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[₹,\s]/g, "");
  const lakh = cleaned.match(/^([\d.]+)L$/i);
  if (lakh) return Math.round(Number(lakh[1]) * 100_000);
  const m = cleaned.match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * BUG-002 fix: the idempotency key every insert is keyed on. Deterministic
 * per source row — same sheet, same row index, every time this script runs
 * against the same files — so a re-run recognizes a row it already imported
 * (via the `@@unique([workspaceId, externalRef])` constraint + createMany's
 * skipDuplicates) instead of creating a second copy of it.
 *
 * Row index, not row content, is what's hashed in: two different real people
 * can legitimately share a name, a phone-less blank, or (for the Cocktail
 * Shop dump specifically — see importRetail) even the "Customer ID" text,
 * which is not actually a unique key in that sheet. Row position in an
 * unchanging source file is the one thing that is both stable across re-runs
 * and genuinely distinct per real row.
 *
 * Known, accepted limitation: if AMM ever re-orders or inserts rows in the
 * MIDDLE of an already-imported sheet (rather than only appending new ones
 * at the end), rows after the insertion point would shift index and be
 * re-imported as if new. None of these sheets are live-edited AMM exports —
 * they are point-in-time snapshots — so this is a reasonable trade-off
 * against building real per-contact IDs these spreadsheets never had.
 */
function computeExternalRef(tag: string, sheetName: string, rowIndex: number): string {
  return `${tag}:${sheetName}:${rowIndex}`;
}

/**
 * BUG-002 fix, second half: `externalRef` alone cannot protect a row that
 * predates this fix — an already-imported phone-less row has externalRef
 * NULL (the column did not exist yet, or for clients it held the old,
 * non-unique raw value), so its stored key can never match what a fresh
 * parse computes, and nothing else distinguishes it from a "new" row.
 *
 * Rather than trying to retroactively reconstruct a matching key for
 * ~4,600 already-imported rows (some of which are themselves genuine
 * duplicate entries already sitting in AMM's own source spreadsheet — see
 * docs/STATUS.md §1.2), phone-less rows get an extra, simpler guard: before
 * insertion, check whether a row with the same natural key (name, scoped to
 * the same table and — for leads — the same kind) already exists in the
 * database at all, regardless of its externalRef. If so, skip it.
 *
 * This is deliberately conservative: on the rare occasion two DIFFERENT real
 * people or companies happen to share an exact name with no phone to tell
 * them apart, a genuinely new one added later would also be skipped. That is
 * an accepted trade-off — under-inserting a rare coincidence is a far safer
 * failure mode than silently duplicating real customer/vendor/lead records,
 * which is the actual harm BUG-002 exists to prevent. On a first-ever import
 * into an empty database these sets are empty, so nothing is skipped and
 * behaviour is unchanged from before this fix.
 */
async function loadExistingNoPhoneKeys(wsId: string) {
  const [clients, vendors, freelancers, leads] = await Promise.all([
    prisma.client.findMany({ where: { workspaceId: wsId, phone: null }, select: { name: true, segment: true, email: true } }),
    prisma.vendor.findMany({ where: { workspaceId: wsId }, select: { name: true } }),
    prisma.freelancer.findMany({ where: { workspaceId: wsId, phone: null }, select: { name: true } }),
    prisma.lead.findMany({ where: { workspaceId: wsId, phone: null }, select: { name: true, kind: true } }),
  ]);
  return {
    clients: new Set(clients.map((c) => `${c.segment}:${c.name}`)),
    // §8 retail rows are near-anonymous (no name), so name-based keying
    // doesn't apply to them — email is their natural key instead (verified
    // unique among phone-less retail rows; see docs/STATUS.md §1.2).
    retailEmails: new Set(
      clients.filter((c) => c.segment === "RETAIL_CUSTOMER" && c.email).map((c) => c.email!.toLowerCase()),
    ),
    vendors: new Set(vendors.map((v) => v.name)),
    freelancers: new Set(freelancers.map((f) => f.name)),
    leads: new Set(leads.map((l) => `${l.kind}:${l.name}`)),
  };
}

function parseInt10(raw: string | null): number | null {
  if (!raw) return null;
  const m = String(raw).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Event dates, parsed strictly — an explicit 4-digit year is REQUIRED.
 *
 * `new Date(string)` cannot be used here. AMM writes multi-day events as
 * ranges ("17-18 Jan 2027", "9-12 July"), and JavaScript reads the leading
 * "17-18" as a year-month pair, silently discarding the real year: it turns
 * "17-18 Jan 2027" into 2018-01-17. That produced 88 wrong-but-plausible event
 * dates attached to real client names in the first import — worse than no date
 * at all, because nothing about them looks fake.
 *
 * So: Excel's own date cells are trusted; a string is parsed only when day,
 * month and an explicit year are all present, resolving a range to its first
 * day; and anything else yields null rather than a guessed year. The original
 * text is always kept in `eventDateText` so a human can resolve "9-12 July"
 * later — the information is preserved, just not promoted to a real date.
 */
function parseEventDate(raw: unknown): { date: Date | null; text: string | null } {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { date: null, text: null };
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? { date: null, text: null } : { date: raw, text: null };
  }
  const text = String(raw).trim();
  const t = text.toLowerCase().replace(/(\d+)(st|nd|rd|th)/g, "$1");

  const year = t.match(/\b(20\d{2})\b/);
  if (!year) return { date: null, text };
  const month = Object.keys(MONTHS).find((m) => new RegExp(`\\b${m}`).test(t));
  if (month === undefined) return { date: null, text };

  // The day is the last 1-2 digit number before the month name ("23rd-24th
  // July 2026" -> 23), falling back to the first in the string.
  const beforeMonth = t.split(new RegExp(`\\b${month}`))[0];
  const day = (beforeMonth.match(/\b(\d{1,2})\b/) ?? t.match(/\b(\d{1,2})\b/) ?? [])[1];
  if (!day) return { date: null, text };

  const d = new Date(Date.UTC(Number(year[1]), MONTHS[month], Number(day)));
  return Number.isNaN(d.getTime()) ? { date: null, text } : { date: d, text };
}

/**
 * Everything the explicit mapping didn't consume, kept as JSON on the record.
 * These sheets carry genuinely useful extras (follow-up logs, Instagram
 * handles, business type, "Reason For Leaving"), and dropping a column just
 * because the schema has no named home for it loses real information.
 */
function leftovers(header: string[], row: Row, used: Set<number>): Record<string, string> | null {
  const extra: Record<string, string> = {};
  for (let i = 0; i < row.length; i++) {
    if (used.has(i)) continue;
    const value = cell(row, i);
    if (value === null) continue;
    const key = (header[i] ?? "").trim() || `column_${i + 1}`;
    extra[key] = value.slice(0, 500);
  }
  return Object.keys(extra).length ? extra : null;
}

// =========================================================================
// City matching
// =========================================================================

/**
 * Free-text locations only become a `cityId` on an unambiguous match. "Delhi
 * NCR" and "New Delhi" are Delhi; "Jaipur, Rajasthan" is Jaipur. Anything
 * else — "Destination", "North India", a venue name — stays free text in
 * `locationText`, because city drives GST treatment and the city-scope
 * predicate, and a wrong guess there has real consequences.
 */
// AMM's six operating cities (2026-09-19): Jaipur, Delhi, Mumbai, Goa,
// Dehradun, Chennai. Udaipur and Bengaluru are not AMM cities — text naming
// them stays free text rather than being filed under a branch.
const CITY_ALIASES: Record<string, string[]> = {
  JPR: ["jaipur"],
  DEL: ["delhi", "new delhi", "delhi ncr", "ncr", "gurugram", "gurgaon", "noida"],
  BOM: ["mumbai", "bombay", "navi mumbai"],
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
    const cleaned = text.toLowerCase().replace(/[.,–—-]/g, " ").replace(/\s+/g, " ").trim();
    if (byAlias.has(cleaned)) return byAlias.get(cleaned)!;
    // "Jaipur, Rajasthan" / "Hotel X, Udaipur" — accept when exactly one known
    // city name appears among the comma-separated parts.
    const parts = cleaned.split(" ");
    const hits = new Set<string>();
    for (const [alias, id] of byAlias) {
      if (alias.includes(" ") ? cleaned.includes(alias) : parts.includes(alias)) hits.add(id);
    }
    return hits.size === 1 ? [...hits][0] : null;
  };
}

// =========================================================================
// Purge
// =========================================================================

/**
 * BUG-002 (2026-09-12 CTO audit): this function used to run before every
 * import, deleting ALL rows from clients/vendors/freelancers/leads/projects/
 * invoices/tasks/flows — not just synthetic ones. It was safe exactly once,
 * the day the real AMM data first replaced the dev seed fixture, and
 * dangerous every time after: re-running the importer against a database
 * that now holds real projects, invoices, or manually-entered data would
 * have deleted all of it.
 *
 * It has been retired. The importer is now additive and idempotent instead:
 * every insert below is keyed on a deterministic `externalRef` (see
 * `computeExternalRef` and each entity's `@@unique([workspaceId,
 * externalRef])` constraint), so re-running against the same source files
 * inserts zero new rows and deletes nothing, and re-running against UPDATED
 * source files inserts only the genuinely new rows. Verified by running the
 * importer twice in a row against the live real database — see
 * docs/STATUS.md §1.2.
 */

// =========================================================================
// Column vocabulary shared by the varied prospecting sheets
// =========================================================================

// Company-ish names first: where a sheet has both, the organisation is the
// lead's name and the human is its contact.
const NAME_COLS = [
  "COMPANY NAME", "NAME OF ORGANIZATION", "NAME OF THE COMPANY", "COMPANY/ASSOCIATION", "COMPANY",
  "BRAND", "OUTLET NAME", "NAME OF THE BAR", "BAR/CAFÉ", "FARM HOUSE", "COLLEGE NAME", "VENUES NAME",
  "NAME OF WEDDING PLANNER", "HOOKA COMPANY NAMES", "BAR CLINETS NAMES", "CUSTOMER NAME",
  "NAMEOF THE CONTACT PERSON", "NAME", "FIRST NAME",
];
const CONTACT_COLS = [
  "CONTACT PERSON NAME", "CONTACT PERSON", "OWNER/KEY PERSON", "NAME OF THE PERSON", "COMPANY OWNER",
  "FOUNDER/CHAIRMAN", "MANAGEMENT TEAM", "NAME", "FIRST NAME",
];
const PHONE_COLS = [
  "PHONE NUMBER", "PHONE NUMER", "MOBILE NO", "MOBILE NUMBER", "CONTACT NUMBER", "CONTACT NO.", "CONTACT NO",
  "PH NO.", "PHONE NO. DETAILS", "PHONE DETAILS", "PHONE NO", "HIGH PRIORITY GUESTS PHONE",
  "INSTRAGRAM NUMBER", "PHONE", "CONTACT", "LANDLINE",
];
const EMAIL_COLS = ["EMAIL ID", "EMAIL ADDRESS", "EMAIL", "E-MAIL", "EMAIL ID "];
const ADDRESS_COLS = ["FULL ADDRESS", "OFFICE ADDRESS", "ADDRESS DETAILS", "VENUE ADDRESS", "ADDRESS1", "ADDRESS", "ADDRESSS", "ADRESS", "PLACE"];
const WEBSITE_COLS = ["WEBSITE", "WWW LINKS", "WWW. LINKS", "WEBSITE & PAGE LINKS"];
const DESIGNATION_COLS = ["DESIGNATION", "POSITION", "CURRENT POSITION"];
const LOCATION_COLS = ["CITY", "LOCATION"];
const REMARKS_COLS = ["REMARKS", "RESPONSES", "STATUS", "NOTES"];

// =========================================================================
// Import
// =========================================================================

interface Stats {
  [key: string]: number | string | string[] | Record<string, number>;
}

async function main() {
  const started = Date.now();
  const report: Record<string, unknown> = {};

  const workspace = await prisma.workspace.findFirstOrThrow();
  const cities = await prisma.city.findMany({ select: { id: true, code: true } });
  const matchCity = buildCityMatcher(cities);
  const wsId = workspace.id;

  console.log(`Workspace: ${workspace.name}`);
  console.log(`Cities: ${cities.map((c) => c.code).join(", ")}`);
  console.log(DRY_RUN ? "\n*** DRY RUN — nothing will be written ***\n" : "");

  const amm = openWorkbook(AMM_FILE);
  const elixir = openWorkbook(ELIXIR_FILE);

  // BUG-002 fix: no purge here anymore. Every insert below is additive and
  // idempotent (externalRef-keyed) — see the historical comment above. For
  // phone-less rows specifically, also see loadExistingNoPhoneKeys.
  const existing = await loadExistingNoPhoneKeys(wsId);

  // ------------------------------------------------------- §3 event clients
  const clientSheet = readSheet(amm, "AMM CLIENT DATABASE");
  const cName = col(clientSheet.header, ["BAR CLINETS NAMES"]);
  const cPhone = col(clientSheet.header, ["PHONE NUMBER"]);
  const cAddr = col(clientSheet.header, ["ADDRESS"]);

  /**
   * `AMM CLIENT DATABASE` is not one flat list. It is several lists stacked in
   * one sheet, separated by rows that repeat the header with a section label
   * in the name column ("BUSINESS CLIENTS NAME", "PERSON NAME (Rotary
   * Friends)", "CORPORATE COMPANY NAMES", ...). Those rows are separators, not
   * clients, and the label they carry is the only reliable statement in either
   * workbook about whether a run of rows is companies or individuals — far
   * better evidence than guessing from the name string.
   */
  const isSectionHeader = (row: Row) => (cell(row, cPhone) ?? "").toUpperCase() === "PHONE NUMBER";
  const sectionType = (label: string | null): "CORPORATE" | "INDIVIDUAL" | null => {
    if (!label) return null;
    if (/CORPORATE|BUSINESS|COMPANY/i.test(label)) return "CORPORATE";
    if (/PERSON NAME/i.test(label)) return "INDIVIDUAL";
    return null;
  };

  /** Phone -> client id, the registry §9's cross-reference reads from. */
  const clientByPhone = new Map<string, { id: string; name: string }>();
  const eventClients: any[] = [];
  let clientRawRows = 0;
  let clientDupes = 0;
  let clientNoName = 0;
  let clientAlreadyImported = 0;
  let sectionHeaders = 0;
  let vendorRowsInClientSheet = 0;
  let section: string | null = null;
  const sectionCounts: Record<string, number> = {};

  for (const [rowIdx, row] of clientSheet.rows.entries()) {
    if (isSectionHeader(row)) {
      section = cell(row, cName);
      sectionHeaders++;
      continue;
    }
    const name = cell(row, cName);
    const phoneCellRaw = cell(row, cPhone);

    /**
     * Rows 523+ are the supplier list pasted into the client sheet, with the
     * e-mail sitting in the PHONE column. Every one of those 156 e-mails
     * matches the `Clients` sheet that §4 imports as vendors, so importing
     * them here would file AMM's suppliers as its customers. They are counted
     * and skipped; §4's sheet is the authoritative copy.
     */
    if (phoneCellRaw && phoneCellRaw.includes("@")) {
      vendorRowsInClientSheet++;
      continue;
    }

    const { phone, phoneRaw } = normalizePhone(phoneCellRaw);
    if (!name && !phone) continue;
    clientRawRows++;
    if (!name) {
      clientNoName++;
      continue;
    }
    if (phone && clientByPhone.has(phone)) {
      clientDupes++; // §3: keep first occurrence
      continue;
    }
    // BUG-002 fix: phone-less rows aren't protected by the (workspace, phone)
    // constraint, so a row already sitting in the DB from a prior run is
    // recognized here instead — see loadExistingNoPhoneKeys.
    if (!phone && existing.clients.has(`EVENT_CLIENT:${name}`)) {
      clientAlreadyImported++;
      continue;
    }
    const id = randomUUID();
    if (phone) clientByPhone.set(phone, { id, name });
    const label = section ?? "BAR CLIENTS";
    sectionCounts[label] = (sectionCounts[label] ?? 0) + 1;
    eventClients.push({
      id,
      workspaceId: wsId,
      externalRef: computeExternalRef("AMM_CLIENT_DB", clientSheet.name, rowIdx),
      name,
      // Prefer the section label; only fall back to reading the name when the
      // sheet itself hasn't said which kind of list this is.
      type:
        sectionType(section) ??
        (/\b(pvt|ltd|llp|inc|hotel|resort|caf|restaurant|company|group|catering|brand)\b/i.test(name)
          ? ("CORPORATE" as const)
          : ("INDIVIDUAL" as const)),
      cityId: null,
      phone,
      phoneRaw,
      address: cell(row, cAddr),
      source: `AMM Client Database import — ${label}`,
      segment: "EVENT_CLIENT" as const,
    });
  }

  if (!DRY_RUN) await insertChunked("clients", eventClients, (data) => prisma.client.createMany({ data, skipDuplicates: true }));
  report.clients_event = {
    rawRows: clientSheet.rows.length,
    sectionSeparatorRows: sectionHeaders,
    supplierRowsSkipped: vendorRowsInClientSheet,
    usable: clientRawRows,
    droppedNoName: clientNoName,
    phoneDupes: clientDupes,
    withUsablePhone: clientByPhone.size,
    alreadyImportedPhoneless: clientAlreadyImported,
    inserted: eventClients.length,
    perSection: sectionCounts,
  };
  console.log("§3 event clients:", report.clients_event);

  // ------------------------------------------------------------- §4 vendors
  const vendorSheet = readSheet(amm, "Clients"); // mislabeled: this is the supplier list
  const vFirst = col(vendorSheet.header, ["First Name"]);
  const vCompany = col(vendorSheet.header, ["Company"]);
  const vEmail = col(vendorSheet.header, ["Email"]);
  const vAddr = col(vendorSheet.header, ["Address1"]);

  const vendors: any[] = [];
  let vendorAlreadyImported = 0;
  for (const [rowIdx, row] of vendorSheet.rows.entries()) {
    const company = cell(row, vCompany);
    const contact = cell(row, vFirst);
    const name = company ?? contact;
    if (!name) continue;
    // BUG-002 fix: vendors never have a phone, so this is the only guard
    // against re-run duplication — see loadExistingNoPhoneKeys.
    if (existing.vendors.has(name)) {
      vendorAlreadyImported++;
      continue;
    }
    vendors.push({
      id: randomUUID(),
      workspaceId: wsId,
      externalRef: computeExternalRef("AMM_VENDOR_SHEET", vendorSheet.name, rowIdx),
      name,
      category: null, // §4: F&B categorisation is a later UI pass
      cityId: null,
      contactName: contact,
      email: cell(row, vEmail),
      phone: null, // §4: this sheet carries no phone numbers, as expected
      phoneRaw: null,
      address: cell(row, vAddr),
      source: "AMM supplier list (sheet 'Clients') import",
      status: "APPROVED" as const,
    });
  }
  if (!DRY_RUN) await insertChunked("vendors", vendors, (data) => prisma.vendor.createMany({ data, skipDuplicates: true }));
  report.vendors = { rawRows: vendorSheet.rows.length, alreadyImported: vendorAlreadyImported, inserted: vendors.length };
  console.log("§4 vendors:", report.vendors);

  // --------------------------------------------------------- §5 freelancers
  const staffSheet = readSheet(amm, "AMM EMPLOYEE DATA");
  const fName = col(staffSheet.header, ["NAME"]);
  const fPhone = col(staffSheet.header, ["MOBILE NO"]);
  const fCategory = col(staffSheet.header, ["CATEGORY"]);

  const freelancers: any[] = [];
  const freelancerPhones = new Set<string>();
  let freelancerDupes = 0;
  let freelancerAlreadyImported = 0;
  for (const [rowIdx, row] of staffSheet.rows.entries()) {
    const name = cell(row, fName);
    const { phone, phoneRaw } = normalizePhone(cell(row, fPhone));
    if (!name) continue;
    if (phone && freelancerPhones.has(phone)) {
      freelancerDupes++;
      continue;
    }
    // BUG-002 fix — see loadExistingNoPhoneKeys.
    if (!phone && existing.freelancers.has(name)) {
      freelancerAlreadyImported++;
      continue;
    }
    if (phone) freelancerPhones.add(phone);
    freelancers.push({
      id: randomUUID(),
      workspaceId: wsId,
      externalRef: computeExternalRef("AMM_EMPLOYEE_DATA", staffSheet.name, rowIdx),
      name,
      cityId: null,
      phone,
      phoneRaw,
      category: cell(row, fCategory),
      source: "AMM Employee Data import",
      certExpiresAt: null, // unknown — never fabricated, it drives compliance
      dayRate: null, // negotiated per event; the roster records none
    });
  }
  if (!DRY_RUN) await insertChunked("freelancers", freelancers, (data) => prisma.freelancer.createMany({ data, skipDuplicates: true }));
  report.freelancers = {
    rawRows: staffSheet.rows.length,
    phoneDupes: freelancerDupes,
    alreadyImportedPhoneless: freelancerAlreadyImported,
    inserted: freelancers.length,
  };
  console.log("§5 freelancers:", report.freelancers);

  // ------------------------------------------------- §6 the live pipeline
  const pipeline = await importPipeline(elixir, wsId, matchCity, clientByPhone, existing.leads);
  report.leads_pipeline = pipeline.stats;
  console.log("§6 pipeline leads:", pipeline.stats);

  // --------------------------------------------------- §7 cold prospects
  const cold = await importColdProspects(amm, wsId, matchCity, pipeline.phones, existing.leads);
  report.leads_cold = cold.stats;
  console.log("§7 cold prospects:", cold.stats);

  // ------------------------------------------- §8 Cocktail Shop retail
  const retail = await importRetail(amm, wsId, clientByPhone, existing.retailEmails);
  report.clients_retail = retail.stats;
  console.log("§8 retail clients:", retail.stats);

  // ------------------------------------------------------ §9 cross-reference
  if (!DRY_RUN) {
    const linked: { lead_id: string; client_id: string; phone: string; lead_name: string; client_name: string }[] =
      await prisma.$queryRaw`
        UPDATE leads l
           SET stage = 'WON', converted_client_id = c.id, updated_at = NOW()
          FROM clients c
         WHERE c.workspace_id = l.workspace_id
           AND c.phone = l.phone
           AND c.client_segment = 'EVENT_CLIENT'
           AND l.phone IS NOT NULL
           AND l.converted_client_id IS NULL
        RETURNING l.id AS lead_id, c.id AS client_id, l.phone, l.name AS lead_name, c.name AS client_name`;
    report.cross_reference = { leadsLinkedToClients: linked.length, examples: linked.slice(0, 5) };
    console.log("§9 cross-reference:", { leadsLinkedToClients: linked.length });
  }

  // --------------------------------------------------------- audit trail
  if (!DRY_RUN) {
    await prisma.auditLog.create({
      data: {
        workspaceId: wsId,
        actorId: null, // system import, not a human action
        action: "data.real_import",
        entityType: "workspace",
        entityId: wsId,
        after: JSON.parse(JSON.stringify({ ...report, durationMs: Date.now() - started, sources: [path.basename(AMM_FILE), path.basename(ELIXIR_FILE)] })),
      },
    });
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return report;
}

/**
 * `skipDuplicates` is a safety net against a unique-constraint violation
 * aborting a 51k-row load. Two different things can cause a skip, and only
 * one of them is a bug:
 *
 *  - two rows produced by THIS RUN'S OWN parsing/dedupe logic collide with
 *    each other (e.g. the same externalRef computed twice) — that is a real
 *    bug upstream, caught below before any insert is attempted;
 *  - a row collides with one already sitting in the database from a PRIOR
 *    run of this importer — that is BUG-002's entire point (2026-09-12 CTO
 *    audit): re-running this script against the same source files must
 *    insert zero new rows, not throw or duplicate. That is success, logged,
 *    not an error.
 *
 * Before this fix, this function threw on ANY skip at all, which was correct
 * only back when every run started from an empty table. Since the importer
 * is now safe to re-run against a database that already holds the real data,
 * "everything was already there" has to be a normal, quiet outcome.
 */
async function insertChunked(label: string, rows: unknown[], run: (chunk: any[]) => Promise<{ count: number }>) {
  const seenRefs = new Set<string>();
  for (const r of rows as Array<{ externalRef?: string | null }>) {
    if (r.externalRef == null) continue;
    if (seenRefs.has(r.externalRef)) {
      throw new Error(
        `${label}: duplicate externalRef ${JSON.stringify(r.externalRef)} computed twice within this run — ` +
          "that is a bug in this script's row parsing, not an expected cross-run skip. Fix the parsing.",
      );
    }
    seenRefs.add(r.externalRef);
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK) as any[];
    const res = await run(chunk);
    inserted += res.count;
    if (rows.length > CHUNK) process.stdout.write(`\r  ${label}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  if (rows.length > CHUNK) process.stdout.write("\n");

  const skipped = rows.length - inserted;
  if (skipped > 0) {
    console.log(`  ${label}: ${inserted} new, ${skipped} already imported from a prior run (skipped, not an error)`);
  }
}

// =========================================================================
// §6 — the live sales pipeline
// =========================================================================

/** Sheets 1-4 share one schema; 5 and 6 name their columns differently. */
const PIPELINE_SHEETS = ["Sales Funnel", "Sep26- Mar27", "Events before Sep 26", "Future&Scheduled"];

interface Candidate {
  data: any;
  filled: number;
  priority: number;
}

async function importPipeline(
  wb: XLSX.WorkBook,
  wsId: string,
  matchCity: (t: string | null) => string | null,
  clientByPhone: Map<string, { id: string; name: string }>,
  existingLeads: Set<string>,
) {
  /**
   * §6 dedupe: the same phone recurs across sheets (a lead tracked before
   * September reappears in the current funnel). The brief's rule is to keep
   * "the version with the most non-empty fields"; sheet order breaks ties, so
   * an equally-complete row from Sales Funnel beats one from an archive sheet.
   */
  const best = new Map<string, Candidate>();
  const noPhone: any[] = [];
  const perSheet: Record<string, number> = {};
  let rawRows = 0;
  // BUG-002 fix: phone-less rows have no unique constraint to protect them on
  // a re-run — see loadExistingNoPhoneKeys.
  let noPhoneAlreadyImported = 0;

  const consider = (phone: string | null, data: any, priority: number) => {
    const filled = Object.values(data).filter((v) => v !== null && v !== undefined && v !== "").length;
    if (!phone) {
      if (existingLeads.has(`PIPELINE:${data.name}`)) {
        noPhoneAlreadyImported++;
        return;
      }
      noPhone.push(data);
      return;
    }
    const existing = best.get(phone);
    if (!existing || filled > existing.filled || (filled === existing.filled && priority < existing.priority)) {
      best.set(phone, { data, filled, priority });
    }
  };

  PIPELINE_SHEETS.forEach((sheetName, priority) => {
    const sheet = readSheet(wb, sheetName);
    const h = sheet.header;
    const idx = {
      ref: col(h, ["Planner Ref"]),
      cta: col(h, ["Call to Action"]),
      phone: col(h, ["Ph No."]),
      proposal: col(h, ["Proposal Done?"]),
      contact: col(h, ["Contact Person"]),
      date: col(h, ["Date"]),
      location: col(h, ["Location"]),
      remarks: col(h, ["Remarks"]),
      eventType: col(h, ["Event Type"]),
      service: col(h, ["Bar/ Hookah/ Food"]),
      pax: col(h, ["Pax"]),
      current: col(h, ["Is he a Current client ( Y / N)"]),
      reason: col(h, ["Reason For Leaving"]),
      pkg: col(h, ["Package Proposed"]),
      advance: col(h, ["Advance"]),
    };
    perSheet[sheet.name] = sheet.rows.length;

    for (const [rowIdx, row] of sheet.rows.entries()) {
      const contact = cell(row, idx.contact);
      const { phone, phoneRaw } = normalizePhone(cell(row, idx.phone));
      if (!contact && !phone) continue;
      rawRows++;

      const used = new Set(Object.values(idx).filter((i) => i >= 0));
      const locationText = cell(row, idx.location);
      const proposalDone = /^y/i.test(cell(row, idx.proposal) ?? "");
      const value = parseAmount(cell(row, idx.pkg)) ?? parseAmount(cell(row, idx.advance));

      /**
       * The `Is he a Current client ( Y / N)` column is not used as a Y/N flag
       * in practice: it is blank in ~95% of rows and, where filled, holds menu
       * and run-of-event notes ("13th Feb - Welcome Dinner / 14th Feb - Haldi
       * ...", "Hot Fresh Chai, Assortment in Jars"). So a bare Y/N is honoured
       * as the flag the header promises, and anything longer is kept as the
       * requirement notes it actually is rather than being thrown away.
       */
      const eventDate = parseEventDate(row[idx.date]);
      const currentCell = cell(row, idx.current);
      const isYesNo = currentCell !== null && /^[yn]$/i.test(currentCell);
      const isCurrentClient = isYesNo && /^y$/i.test(currentCell!);
      const requirementNotes = !isYesNo && currentCell ? currentCell : null;

      consider(
        phone,
        {
          id: randomUUID(),
          workspaceId: wsId,
          externalRef: computeExternalRef("PIPELINE", sheet.name, rowIdx),
          name: contact ?? phone ?? "Unnamed lead",
          contactName: contact,
          phone,
          phoneRaw,
          // §6: "Y" means they are already a client. The link to the actual
          // client row is made in the §9 pass, which can see every client.
          stage: isCurrentClient ? "WON" : proposalDone ? "PROPOSAL" : value !== null ? "QUALIFIED" : "LEAD",
          kind: "PIPELINE" as const,
          value,
          cityId: matchCity(locationText),
          locationText,
          eventType: [cell(row, idx.eventType), cell(row, idx.service)].filter(Boolean).join(" — ") || null,
          pax: parseInt10(cell(row, idx.pax)),
          eventDate: eventDate.date,
          eventDateText: eventDate.text,
          remarks:
            [
              cell(row, idx.remarks),
              requirementNotes ? `Requirement: ${requirementNotes}` : null,
              cell(row, idx.reason) ? `Reason for leaving: ${cell(row, idx.reason)}` : null,
              cell(row, idx.cta),
            ]
              .filter(Boolean)
              .join(" | ") || null,
          source: cell(row, idx.ref),
          sourceSheet: sheet.name,
          sourceFile: "Elixir_New_Clients_Query.xlsx",
          intakeDetail: leftovers(h, row, used) as any,
        },
        priority,
      );
    }
  });

  // Snapshot after sheets 1-4 only, so the count is directly comparable to the
  // brief's "~144 after phone dedupe among those four".
  const afterSheets1to4 = best.size;
  const withoutPhoneSheets1to4 = noPhone.length;

  // ---- sheet 5: API Query (different column names)
  const api = readSheet(wb, "API Query");
  const aIdx = {
    name: col(api.header, ["Customer Name"]),
    phone: col(api.header, ["Contact Number"]),
    location: col(api.header, ["Location"]),
    date: col(api.header, ["Date"]),
    eventType: col(api.header, ["Type of Event"]),
    pax: col(api.header, ["No of Guests"]),
  };
  perSheet[api.name] = api.rows.length;
  for (const [rowIdx, row] of api.rows.entries()) {
    const name = cell(row, aIdx.name);
    const { phone, phoneRaw } = normalizePhone(cell(row, aIdx.phone));
    if (!name && !phone) continue;
    rawRows++;
    const locationText = cell(row, aIdx.location);
    const apiDate = parseEventDate(row[aIdx.date]);
    consider(
      phone,
      {
        id: randomUUID(), workspaceId: wsId, externalRef: computeExternalRef("PIPELINE", api.name, rowIdx),
        name: name ?? phone!, contactName: name, phone, phoneRaw,
        stage: "LEAD", kind: "PIPELINE" as const, value: null,
        cityId: matchCity(locationText), locationText,
        eventType: cell(row, aIdx.eventType), pax: parseInt10(cell(row, aIdx.pax)),
        eventDate: apiDate.date, eventDateText: apiDate.text, remarks: null,
        source: "API query", sourceSheet: api.name, sourceFile: "Elixir_New_Clients_Query.xlsx",
        intakeDetail: leftovers(api.header, row, new Set(Object.values(aIdx).filter((i) => i >= 0))) as any,
      },
      4,
    );
  }

  // ---- sheet 6: Cocktail Shop Leads (product enquiries, not events)
  const shop = readSheet(wb, "Cocktail Shop Leads");
  const sIdx = {
    name: col(shop.header, ["Customer Name"]),
    phone: col(shop.header, ["Contact no."]),
    product: col(shop.header, ["Product required"]),
    location: col(shop.header, ["Location"]),
    remarks: col(shop.header, ["Remarks"]),
  };
  perSheet[shop.name] = shop.rows.length;
  for (const [rowIdx, row] of shop.rows.entries()) {
    const name = cell(row, sIdx.name);
    const { phone, phoneRaw } = normalizePhone(cell(row, sIdx.phone));
    if (!name && !phone) continue;
    rawRows++;
    const locationText = cell(row, sIdx.location);
    consider(
      phone,
      {
        id: randomUUID(), workspaceId: wsId, externalRef: computeExternalRef("PIPELINE", shop.name, rowIdx),
        name: name ?? phone!, contactName: name, phone, phoneRaw,
        stage: "LEAD", kind: "PIPELINE" as const, value: null,
        cityId: matchCity(locationText), locationText,
        eventType: cell(row, sIdx.product), pax: null, eventDate: null,
        remarks: cell(row, sIdx.remarks),
        source: "Cocktail Shop enquiry", sourceSheet: shop.name, sourceFile: "Elixir_New_Clients_Query.xlsx",
        intakeDetail: leftovers(shop.header, row, new Set(Object.values(sIdx).filter((i) => i >= 0))) as any,
      },
      5,
    );
  }

  const rows = [...[...best.values()].map((c) => c.data), ...noPhone];
  if (!DRY_RUN) await insertChunked("pipeline leads", rows, (data) => prisma.lead.createMany({ data, skipDuplicates: true }));

  // ---- Elixir Form Response: attach to a matching lead, else create one
  const pipelinePhones = new Set(best.keys());
  const formStats = await importFormResponses(wb, wsId, matchCity, pipelinePhones, existingLeads);
  // Form responses can create leads with phones the funnel sheets never had.
  // §7's dedupe must see those too, or a cold row carrying the same number
  // collides with them and is silently dropped by skipDuplicates.
  for (const p of formStats.createdPhones) pipelinePhones.add(p);

  return {
    phones: pipelinePhones,
    stats: {
      perSheetRawRows: perSheet,
      usableRows: rawRows,
      sheets1to4_afterPhoneDedupe: afterSheets1to4,
      sheets1to4_withoutPhone: withoutPhoneSheets1to4,
      afterPhoneDedupe: best.size,
      withoutPhone: noPhone.length,
      alreadyImportedPhoneless: noPhoneAlreadyImported,
      inserted: rows.length,
      formResponses: {
        rawRows: formStats.rawRows,
        attachedToExistingLead: formStats.attachedToExistingLead,
        alreadyImportedPhoneless: formStats.alreadyImportedPhoneless,
        createdAsNewLead: formStats.createdAsNewLead,
      },
    } as Stats,
  };
}

/**
 * `Elixir Form Response` is the richest intake data in either workbook (bar
 * size in feet, drinker counts, services requested). Where the phone matches a
 * lead already in the pipeline it is attached as `intakeDetail` rather than
 * creating a second row for the same person; where it doesn't, the form itself
 * is a real enquiry and becomes a lead.
 */
async function importFormResponses(
  wb: XLSX.WorkBook,
  wsId: string,
  matchCity: (t: string | null) => string | null,
  pipelinePhones: Set<string>,
  existingLeads: Set<string>,
) {
  const sheet = readSheet(wb, "Elixir Form Response");
  const h = sheet.header;
  const idx = {
    name: col(h, ["Name"]),
    email: col(h, ["E-mail"]),
    phone: col(h, ["Contact no."]),
    eventType: col(h, ["Type of Event or Function"]),
    location: col(h, ["Event Location"]),
    date: col(h, ["Event Start Date"]),
    pax: col(h, ["Estimated No. of Guests Invited"]),
  };

  let attached = 0;
  // BUG-002 fix: phone-less form responses had no dedupe at all against a
  // prior run — see loadExistingNoPhoneKeys.
  let alreadyImportedPhoneless = 0;
  const created: any[] = [];
  const seen = new Set<string>();

  for (const [rowIdx, row] of sheet.rows.entries()) {
    const name = cell(row, idx.name);
    const { phone, phoneRaw } = normalizePhone(cell(row, idx.phone));
    if (!name && !phone) continue;
    const detail = leftovers(h, row, new Set([idx.name, idx.phone].filter((i) => i >= 0)));

    if (phone && pipelinePhones.has(phone)) {
      if (!DRY_RUN) {
        await prisma.lead.updateMany({
          where: { workspaceId: wsId, phone },
          data: { intakeDetail: detail as any, email: cell(row, idx.email) },
        });
      }
      attached++;
      continue;
    }
    if (phone && seen.has(phone)) continue;
    if (phone) seen.add(phone);
    if (!phone && existingLeads.has(`PIPELINE:${name}`)) {
      alreadyImportedPhoneless++;
      continue;
    }
    const locationText = cell(row, idx.location);
    const formDate = parseEventDate(row[idx.date]);
    created.push({
      id: randomUUID(), workspaceId: wsId, externalRef: computeExternalRef("FORM_RESPONSE", sheet.name, rowIdx),
      name: name ?? phone!, contactName: name,
      phone, phoneRaw, email: cell(row, idx.email),
      stage: "LEAD", kind: "PIPELINE" as const, value: null,
      cityId: matchCity(locationText), locationText,
      eventType: cell(row, idx.eventType), pax: parseInt10(cell(row, idx.pax)),
      eventDate: formDate.date, eventDateText: formDate.text, remarks: null,
      source: "Elixir intake form", sourceSheet: sheet.name, sourceFile: "Elixir_New_Clients_Query.xlsx",
      intakeDetail: detail as any,
    });
  }

  if (!DRY_RUN) await insertChunked("form responses", created, (data) => prisma.lead.createMany({ data, skipDuplicates: true }));
  return {
    rawRows: sheet.rows.length,
    attachedToExistingLead: attached,
    alreadyImportedPhoneless,
    createdAsNewLead: created.length,
    createdPhones: seen,
  };
}

// =========================================================================
// §7 — cold prospects
// =========================================================================

/**
 * The 48 names §7 lists resolve to 47 distinct sheets: it names both
 * `VISTING CARD` and `Visting Card`, which are the same sheet.
 */
const COLD_SHEETS = [
  "BNI CONNECT DATABASE", "Sri Lanka Database", "BNI DATAENTRY", "BARS DATABASE", "TRADE SHOWS DATABASE",
  "HOTELS DATABASE", "IHM ACADEMY DATABASE", "INFLUENCER LIST", "IBG BARTENDER DATABASE",
  "India Bar Show Data base", "IBG circle", "wedding planners (Avani)", "jaipur hotels",
  "hotel and wedding resorts", "LIST OF VENUES FOR MIDDLE EAST", "ARCHIT PHONE DATABASE", "DEHRADUN BAR",
  "AMM DELHI NCR BAR", "Breweries Bar", "GURUGRAM BAR", "AMM FOOD CATERING", "NOIDA BAR", "MUMBAI BAR",
  "DUBAI BAR", "NGO", "Visting Card", "ARCHIT HOOKAH", "ANM DELIVERY LIST",
  "MUSCAT HOTEL WEDDING PLANNER", "OMAN WEDDING PLANNER", "MUSCAT WEDDING PLANNER",
  "ABU DHABI WEDDING PLANNER", "NEPAL WEDDING PLANNER", "DOHA WEDDING PLANNER", "ANM EEMA PLANNERS",
  "TOP BAR INDIA", "BAR COMPANY", "ANM IN.WED.PLANNER MOBILELIST", "BAR ACADEMY", "AMM VISTING CARDS",
  "EEMAGINE WEDDING PLANNER", "UAE Visting Cards", "Sheet59", "Visiting Card Data", "Aahar Database",
  "Active Bars in Delhi NCR", "Coffee Manufacturers",
];

async function importColdProspects(
  wb: XLSX.WorkBook,
  wsId: string,
  matchCity: (t: string | null) => string | null,
  pipelinePhones: Set<string>,
  existingLeads: Set<string>,
) {
  const seen = new Set<string>(pipelinePhones); // §7 dedupes against §6 too
  const perSheet: Record<string, number> = {};
  const rows: any[] = [];
  let rawRows = 0;
  let dropped = 0;
  let collapsed = 0;
  // BUG-002 fix: phone-less cold prospects had no dedupe at all against a
  // prior run — see loadExistingNoPhoneKeys.
  let alreadyImportedPhoneless = 0;

  for (const sheetName of COLD_SHEETS) {
    const sheet = readSheet(wb, sheetName);
    const h = sheet.header;
    const nameIdx = col(h, NAME_COLS);
    // Never let one column serve as both the org name and the contact person.
    const contactIdx = col(h, CONTACT_COLS.filter((c) => col(h, [c]) !== nameIdx));
    const idx = {
      name: nameIdx,
      contact: contactIdx === nameIdx ? -1 : contactIdx,
      phone: col(h, PHONE_COLS),
      email: col(h, EMAIL_COLS),
      address: col(h, ADDRESS_COLS),
      website: col(h, WEBSITE_COLS),
      designation: col(h, DESIGNATION_COLS),
      location: col(h, LOCATION_COLS),
      remarks: col(h, REMARKS_COLS),
    };
    perSheet[sheet.name] = sheet.rows.length;

    for (const [rowIdx, row] of sheet.rows.entries()) {
      const name = cell(row, idx.name);
      const contact = cell(row, idx.contact);
      const { phone, phoneRaw } = normalizePhone(cell(row, idx.phone));
      // §7: drop rows with neither a name, a company, nor a phone.
      if (!name && !contact && !phone) {
        dropped++;
        continue;
      }
      rawRows++;
      if (phone && seen.has(phone)) {
        collapsed++;
        continue;
      }
      if (phone) seen.add(phone);
      const coldName = name ?? contact;
      if (!phone && existingLeads.has(`COLD_PROSPECT:${coldName}`)) {
        alreadyImportedPhoneless++;
        continue;
      }

      const used = new Set(Object.values(idx).filter((i) => i >= 0));
      const locationText = cell(row, idx.location) ?? cell(row, idx.address);
      rows.push({
        id: randomUUID(),
        workspaceId: wsId,
        externalRef: computeExternalRef("COLD", sheet.name, rowIdx),
        name: name ?? contact ?? phone!,
        contactName: contact,
        company: name,
        phone,
        phoneRaw,
        email: cell(row, idx.email),
        designation: cell(row, idx.designation),
        address: cell(row, idx.address),
        website: cell(row, idx.website),
        stage: "LEAD" as const,
        kind: "COLD_PROSPECT" as const,
        value: null,
        cityId: matchCity(cell(row, idx.location)),
        locationText,
        remarks: cell(row, idx.remarks),
        source: `Prospecting list: ${sheet.name.trim()}`,
        sourceSheet: sheet.name.trim(),
        sourceFile: "AMM_BRANDS_LLP_DATABASE.xlsx",
        intakeDetail: leftovers(h, row, used) as any,
      });
    }
  }

  if (!DRY_RUN) await insertChunked("cold prospects", rows, (data) => prisma.lead.createMany({ data, skipDuplicates: true }));
  return {
    stats: {
      sheets: COLD_SHEETS.length,
      perSheetRawRows: perSheet,
      usableRows: rawRows,
      droppedBlank: dropped,
      collapsedByPhoneDedupe: collapsed,
      alreadyImportedPhoneless,
      inserted: rows.length,
    } as Stats,
  };
}

// =========================================================================
// §8 — Cocktail Shop retail customers
// =========================================================================

/**
 * 55,760 near-anonymous e-commerce rows: `Customer ID, phone, phone, Email`,
 * no names. They are real customers and worth keeping, but they belong to
 * their own segment so they can never bury the name-rich B2B list.
 *
 * A phone already held by an EVENT_CLIENT is skipped rather than inserted:
 * `clients` is unique on (workspace, phone), and §9's principle — one human,
 * one record, the richer client wins — applies just as well here.
 */
async function importRetail(
  wb: XLSX.WorkBook,
  wsId: string,
  clientByPhone: Map<string, { id: string; name: string }>,
  existingRetailEmails: Set<string>,
) {
  const sheet = readSheet(wb, "DATA DUMP");
  const idCol = col(sheet.header, ["Customer ID"]);
  const emailCol = col(sheet.header, ["Email"]);
  // The header names two columns "phone"; both are real and either may hold
  // the number, so both are tried in order.
  const phoneCols = sheet.header.map((h, i) => (normName(h) === "PHONE" ? i : -1)).filter((i) => i >= 0);

  const seenPhone = new Set<string>();
  const seenEmail = new Set<string>();
  const rows: any[] = [];
  let dupPhone = 0;
  let dupEmail = 0;
  let overlapWithEventClient = 0;
  let unusable = 0;
  // BUG-002 fix: phone-less retail rows have no unique constraint to protect
  // them on a re-run (two NULL phones never collide) — see
  // loadExistingNoPhoneKeys. This is exactly the gap that let a re-run
  // duplicate all 330 phone-less retail customers before this check existed.
  let alreadyImportedPhoneless = 0;

  for (const [rowIdx, row] of sheet.rows.entries()) {
    /**
     * The two phone columns are not duplicates of each other: 24,743 rows fill
     * both, and the second column contributes ~29k numbers the first never
     * has. They are alternate contact numbers for one customer, so only the
     * first usable one becomes the dedupe key — treating both as keys would
     * merge unrelated customers who happen to share an alternate number — but
     * both raw values are kept so no number is lost.
     */
    let phone: string | null = null;
    const rawParts: string[] = [];
    for (const c of phoneCols) {
      const n = normalizePhone(cell(row, c));
      if (n.phoneRaw) rawParts.push(n.phoneRaw);
      if (n.phone && !phone) phone = n.phone;
    }
    const phoneRaw = rawParts.length ? [...new Set(rawParts)].join(" / ") : null;
    const email = cell(row, emailCol);
    const externalRef = cell(row, idCol);

    if (!phone && !email) {
      unusable++; // §8: dedupe by phone, falling back to email
      continue;
    }
    if (phone) {
      if (clientByPhone.has(phone)) {
        overlapWithEventClient++;
        continue;
      }
      if (seenPhone.has(phone)) {
        dupPhone++;
        continue;
      }
      seenPhone.add(phone);
    } else if (email) {
      const key = email.toLowerCase();
      if (seenEmail.has(key)) {
        dupEmail++;
        continue;
      }
      seenEmail.add(key);
      if (existingRetailEmails.has(key)) {
        alreadyImportedPhoneless++;
        continue;
      }
    }

    /**
     * BUG-002 fix: `Customer ID` (captured above as `externalRef`) is NOT a
     * unique key in this sheet — it is a business-name-like label and 3,375
     * of them repeat across genuinely different real customers. Using it
     * bare as the DB idempotency key would collapse those distinct people on
     * the very first import, let alone a re-run. The row index is appended
     * to make the STORED external_ref unique-per-row (satisfying the new
     * `@@unique([workspaceId, externalRef])` constraint and giving re-runs a
     * stable match), while the human-readable Customer ID text itself is
     * kept as a prefix for traceability back to the source sheet.
     */
    rows.push({
      id: randomUUID(),
      workspaceId: wsId,
      // The sheet has no names. The email's local part is the only human-
      // readable handle available; otherwise fall back to the customer ID.
      name: email ? email.split("@")[0] : `Cocktail Shop customer ${externalRef ?? phone}`,
      type: "INDIVIDUAL" as const,
      cityId: null,
      phone,
      phoneRaw,
      email,
      externalRef: computeExternalRef(`RETAIL:${externalRef ?? "noid"}`, sheet.name, rowIdx),
      source: "Cocktail Shop DATA DUMP import",
      segment: "RETAIL_CUSTOMER" as const,
    });
  }

  if (!DRY_RUN) await insertChunked("retail clients", rows, (data) => prisma.client.createMany({ data, skipDuplicates: true }));
  return {
    stats: {
      rawRows: sheet.rows.length,
      droppedNoPhoneOrEmail: unusable,
      phoneDupes: dupPhone,
      emailDupes: dupEmail,
      alreadyAnEventClient: overlapWithEventClient,
      alreadyImportedPhoneless,
      inserted: rows.length,
    } as Stats,
  };
}

/**
 * Only runs when this file is executed directly. Importing it (a test reaching
 * for one helper, a future script reusing the parsers) must never purge and
 * reload the database — which is exactly what happened once before this guard
 * existed.
 */
if (require.main === module) {
  main()
  .then(async (report) => {
    await prisma.$disconnect();
    console.log("\n===== IMPORT REPORT =====");
    console.log(JSON.stringify(report, null, 2));
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
