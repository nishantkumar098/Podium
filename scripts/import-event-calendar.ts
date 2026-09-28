/**
 * Podium v2 — import AMM's event calendar as Projects.
 *
 * Source: `AMM_Event_Calender_for_Staff.xlsx`, four sheets. Only
 * "Final Event Calender" is imported: checked row by row on contact + date,
 * NOT ONE row in "October 2025", "November 25" or "December 25" is absent
 * from the master (46/52, 15/32 and 8/9 match exactly, and every remaining
 * row matches on either the date or the contact). Importing all four would
 * create ~93 duplicate events. The month sheets are used only to ENRICH a
 * matched master row with the per-role headcount, address link and timings
 * they carry and the master does not.
 *
 * -- PROJECT, NOT LEAD ------------------------------------------------------
 * The file has no status column: nothing in it says won, quoted, confirmed or
 * cancelled. The nearest signals are "Engagement Letter Signed" (~3% filled)
 * and "Menu Status". Imported as Project because the sheet is the STAFFING
 * calendar — rows carry allocated team names ("26TH LUNCH - RANU, BHAVYA,
 * RAHUL"), headcounts per role and venue, which is work AMM has committed to,
 * not work it is still selling. Every row is keyed on `externalRef`, so if
 * that reading is wrong these rows can be identified and moved as a set.
 *
 * -- THE YEAR --------------------------------------------------------------
 * The dates carry no year: "1st Oct", "26-27th Sept", "3RD-4TH DEC". The year
 * is NOT guessed — it is derived from three pieces of evidence that agree:
 *   1. the month sheets are named "October 2025", "November 25", "December 25";
 *   2. the month distribution across 302 cells is a single season, Sept–Dec
 *      then Jan–Aug, with rows in chronological order;
 *   3. the one cell Excel stored as a real date (rather than text) is
 *      21 Aug 2026 — an August in the back half of that same season.
 * So Sept–Dec is 2025 and Jan–Aug is 2026. The raw string is stored verbatim
 * in `eventDateText` regardless, so every parsed date stays auditable, and a
 * row whose date cannot be read at all is SKIPPED and reported rather than
 * given an invented date.
 *
 * Usage:
 *   pnpm import:event-calendar --dry-run
 *   pnpm import:event-calendar
 */
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { isForbiddenSheet } from "./forbidden-sheet";

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";
const FILE = path.join(UPLOADS, process.env.PODIUM_CALENDAR_FILE ?? "0e936dc5-AMM_Event_Calender_for_Staff.xlsx");

const MASTER = { sheet: "Final Event Calender", headerRow: 1 };
const MONTH_SHEETS: Array<{ sheet: string; headerRow: number }> = [
  { sheet: "October 2025", headerRow: 2 },
  { sheet: "November 25", headerRow: 2 },
  { sheet: "December 25", headerRow: 2 },
];

/** Sept–Dec belong to the first year of the season, Jan–Aug to the second. */
const SEASON_START_YEAR = Number(process.env.PODIUM_SEASON_START_YEAR ?? 2025);

const DRY_RUN = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

const txt = (c: unknown): string | null => {
  if (c === null || c === undefined) return null;
  const s = String(c).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};
const upper = (s: string | null) => (s ? s.toUpperCase() : null);

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * First day of the booking, or null when the cell carries no readable
 * day+month. Returns the FIRST date mentioned: a multi-day row
 * ("29th Nov - Sangeet 2nd Dec - Haldi") is one project starting on the 29th,
 * and the full string is preserved separately.
 */
export function parseEventDate(raw: string | null, seasonStartYear = SEASON_START_YEAR): Date | null {
  if (!raw) return null;

  // Excel already typed a few cells as real dates; trust those outright.
  const asDate = new Date(raw);
  if (/GMT|\d{4}-\d{2}-\d{2}/.test(raw) && !Number.isNaN(asDate.getTime())) {
    return new Date(Date.UTC(asDate.getUTCFullYear(), asDate.getUTCMonth(), asDate.getUTCDate()));
  }

  const s = raw.toUpperCase();
  const m = /(\d{1,2})\s*(?:ST|ND|RD|TH)?\s*(?:[-–—]\s*\d{1,2}\s*(?:ST|ND|RD|TH)?\s*)?(?:TO\s*\d{1,2}\s*(?:ST|ND|RD|TH)?\s*)?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/.exec(s);
  if (!m) return null;

  const day = Number(m[1]);
  let month = MONTHS[m[2]!]!;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  // An explicit 4-digit year in the cell always wins over the season rule.
  const explicit = /\b(20\d{2})\b/.exec(s);
  let year = explicit ? Number(explicit[1]) : month >= 8 ? seasonStartYear : seasonStartYear + 1;

  // A span that crosses a month boundary states the month once, at the end,
  // and it belongs to the LAST day: "31ST TO 1ST NOV" runs 31 Oct → 1 Nov, so
  // the start is in the preceding month. Detected by the start day being
  // greater than the end day, which cannot happen within one month.
  const span = /(\d{1,2})\s*(?:ST|ND|RD|TH)?\s*(?:[-–—]|TO)\s*(\d{1,2})\s*(?:ST|ND|RD|TH)?\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/.exec(s);
  if (span && Number(span[1]) > Number(span[2])) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  const d = new Date(Date.UTC(year, month, day));
  // Rejects 31 Feb and friends rather than letting JS roll them forward.
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

// ---------------------------------------------------------------------------
// Sheet reading
// ---------------------------------------------------------------------------

interface CalendarRow {
  rowIndex: number;
  plannerRef: string | null;
  contact: string | null;
  dateRaw: string | null;
  nature: string | null;
  eventFlow: string | null;
  pax: string | null;
  venue: string | null;
  service: string | null;
  concept: string | null;
  team: string | null;
  pending: string | null;
  timing: string | null;
  addressLink: string | null;
  crew: string | null;
}

function readSheet(book: XLSX.WorkBook, sheet: string, headerRow: number): CalendarRow[] {
  const ws = book.Sheets[sheet];
  if (!ws) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: true });
  const headers = (grid[headerRow] ?? []).map((c) => upper(txt(c)) ?? "");
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const i = headers.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = {
    plannerRef: find(/PLANNER\s*REF/),
    contact: find(/CONTACT\s*PERSON/),
    date: find(/DATE\s*OF\s*EVENT/),
    nature: find(/NATURE\s*OF\s*EVENT/),
    flow: find(/EVENT\s*FLOW/),
    pax: find(/^PAX$/),
    venue: find(/VENUE\s*NAME/, /^LOCATION$/),
    service: find(/BAR\s*\/\s*HOOKAH\s*\/\s*FOOD/, /^SERVICE$/),
    concept: find(/TEAM\s*SIZE\s*BAR\s*CONCEPT/, /^CONCEPT$/),
    team: find(/TEAM\s*NAME/, /TEAM\s*SIZE\s*REQUIRED/),
    pending: find(/PENDING\s*WORK/, /UPDATE\s*\/\s*PENDING\s*WORK/),
    timing: find(/^TIMING/, /^TIMINGS/),
    addressLink: find(/ADDRESS\s*LINK/),
    crew: find(/FREELANCERS?\s*\/\s*STUDENTS/),
  };
  const at = (row: unknown[], i: number) => (i >= 0 ? txt(row[i]) : null);

  return grid
    .map((row, rowIndex) => ({ row: row as unknown[], rowIndex }))
    .filter(({ row, rowIndex }) => rowIndex !== headerRow && row.some((c) => txt(c)))
    .map(({ row, rowIndex }) => ({
      rowIndex,
      plannerRef: at(row, idx.plannerRef),
      contact: at(row, idx.contact),
      dateRaw: at(row, idx.date),
      nature: at(row, idx.nature),
      eventFlow: at(row, idx.flow),
      pax: at(row, idx.pax),
      venue: at(row, idx.venue),
      service: at(row, idx.service),
      concept: at(row, idx.concept),
      team: at(row, idx.team),
      pending: at(row, idx.pending),
      timing: at(row, idx.timing),
      addressLink: at(row, idx.addressLink),
      crew: at(row, idx.crew),
    }));
}

// ---------------------------------------------------------------------------

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(74)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}IMPORT EVENT CALENDAR — ${dbName}`);
  console.log(`${"=".repeat(74)}`);

  const names: string[] = XLSX.readFile(FILE, { bookSheets: true }).SheetNames;
  for (const n of names) if (isForbiddenSheet(n)) throw new Error(`refusing to open sensitive sheet "${n}"`);
  const book = XLSX.readFile(FILE, { sheets: names, cellDates: true });

  const master = readSheet(book, MASTER.sheet, MASTER.headerRow);
  console.log(`\n"${MASTER.sheet}": ${master.length} populated rows`);

  // Enrichment index from the month sheets, keyed the way a human would say
  // "same event": this contact, that date.
  const enrich = new Map<string, CalendarRow>();
  for (const { sheet, headerRow } of MONTH_SHEETS) {
    const rows = readSheet(book, sheet, headerRow);
    for (const r of rows) {
      const key = `${upper(r.contact) ?? ""}@@${upper(r.dateRaw) ?? ""}`;
      if (!enrich.has(key)) enrich.set(key, r);
    }
    console.log(`"${sheet}": ${rows.length} rows read for enrichment only`);
  }

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");

  const cities = await prisma.city.findMany({ where: { workspaceId: workspace.id } });
  const hq = cities.find((c) => c.isHq) ?? cities[0];
  if (!hq) throw new Error("no cities configured");

  // Every Project needs a PM. The calendar names crew, not project managers,
  // so one is assigned and reported rather than left to a random pick — see
  // the report: all imported projects need a real PM assigned in the app.
  const pm =
    (await prisma.user.findFirst({ where: { primaryRole: { name: "Founder" } }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.user.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!pm) throw new Error("no users exist — provision employees before importing the calendar");

  const cityFor = (row: CalendarRow) => {
    const hay = `${row.venue ?? ""} ${row.plannerRef ?? ""}`.toUpperCase();
    return cities.find((c) => hay.includes(c.name.toUpperCase()))?.id ?? hq.id;
  };

  const stats = { rows: master.length, noDate: 0, noName: 0, enriched: 0, cityMatched: 0, prepared: 0 };
  const skipped: string[] = [];

  interface Prepared {
    externalRef: string;
    name: string;
    type: string;
    cityId: string;
    eventDate: Date;
    eventDateText: string;
    clientName: string;
  }
  const prepared: Prepared[] = [];

  for (const row of master) {
    const eventDate = parseEventDate(row.dateRaw);
    if (!eventDate) {
      stats.noDate++;
      skipped.push(`row ${row.rowIndex}: unreadable date ${JSON.stringify(row.dateRaw)} — ${row.contact ?? row.venue ?? "?"}`);
      continue;
    }
    // The event's name: whoever booked it, at wherever it is.
    const who = row.contact ?? row.plannerRef ?? row.venue;
    if (!who) {
      stats.noName++;
      skipped.push(`row ${row.rowIndex}: no contact, planner or venue`);
      continue;
    }

    const extra = enrich.get(`${upper(row.contact) ?? ""}@@${upper(row.dateRaw) ?? ""}`);
    if (extra) stats.enriched++;
    const cityId = cityFor(row);
    if (cityId !== hq.id) stats.cityMatched++;

    prepared.push({
      externalRef: `CALENDAR:${MASTER.sheet}:${row.rowIndex}`,
      name: [who, row.venue].filter(Boolean).join(" — ").slice(0, 200),
      type: row.nature ?? row.service ?? "Event",
      cityId,
      eventDate,
      eventDateText: row.dateRaw!,
      clientName: who,
    });
    stats.prepared++;
  }

  console.log(`\nprepared ${stats.prepared} project(s) from ${stats.rows} rows`);
  console.log(`  enriched from a month sheet : ${stats.enriched}`);
  console.log(`  city matched from the venue : ${stats.cityMatched} (rest default to ${hq.name})`);
  console.log(`  skipped — unreadable date   : ${stats.noDate}`);
  console.log(`  skipped — nothing to name it: ${stats.noName}`);
  for (const s of skipped) console.log(`     SKIPPED ${s}`);

  const years = new Map<number, number>();
  for (const p of prepared) years.set(p.eventDate.getUTCFullYear(), (years.get(p.eventDate.getUTCFullYear()) ?? 0) + 1);
  console.log(`  derived years: ${[...years.entries()].sort().map(([y, n]) => `${y}=${n}`).join(", ")}`);

  if (DRY_RUN) {
    console.log(`\nsample:`);
    for (const p of prepared.slice(0, 6)) {
      console.log(`   ${p.eventDate.toISOString().slice(0, 10)}  ${(p.eventDateText ?? "").padEnd(22).slice(0, 22)}  ${p.name.slice(0, 46)}`);
    }
    console.log(`\nDry run — nothing was written.`);
    return;
  }

  // Clients: match an existing account by normalized name, create one where
  // there is none. The calendar names a contact person, not a billing
  // account, so most of these are genuinely new.
  const existing = await prisma.client.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } });
  const byName = new Map(existing.map((c) => [c.name.trim().toUpperCase(), c.id]));
  let clientsCreated = 0;
  let clientsMatched = 0;

  let written = 0;
  for (const p of prepared) {
    const key = p.clientName.trim().toUpperCase();
    let clientId = byName.get(key);
    if (clientId) {
      clientsMatched++;
    } else {
      const created = await prisma.client.create({
        data: {
          workspaceId: workspace.id,
          name: p.clientName,
          // ClientType is INDIVIDUAL | CORPORATE | BRAND. The calendar names a
          // contact person, not a company, so INDIVIDUAL is the honest default;
          // clientSegment is what actually separates these from the retail dump.
          type: "INDIVIDUAL",
          segment: "EVENT_CLIENT",
          cityId: p.cityId,
          source: "Event calendar import",
          externalRef: `CALENDAR_CLIENT:${key}`,
        },
      });
      clientId = created.id;
      byName.set(key, clientId);
      clientsCreated++;
    }

    await prisma.project.upsert({
      where: { workspaceId_externalRef: { workspaceId: workspace.id, externalRef: p.externalRef } },
      create: {
        workspaceId: workspace.id,
        externalRef: p.externalRef,
        name: p.name,
        clientId,
        type: p.type,
        cityId: p.cityId,
        eventDate: p.eventDate,
        eventDateText: p.eventDateText,
        pmId: pm.id,
        status: "PLANNING",
      },
      update: {
        name: p.name,
        type: p.type,
        cityId: p.cityId,
        eventDate: p.eventDate,
        eventDateText: p.eventDateText,
      },
    });
    written++;
  }

  console.log(`\nwritten: ${written} project(s)`);
  console.log(`clients — matched existing: ${clientsMatched}, created: ${clientsCreated}`);
  console.log(`\nVERIFY — ${dbName} now holds:`);
  console.log(`   projects ${await prisma.project.count()}`);
  console.log(`   clients  ${await prisma.client.count()}`);
  console.log(`\nNOTE: every imported project is assigned to ${pm.name} as PM and left in PLANNING.`);
  console.log(`      The calendar names crew, not project managers — real PMs must be set in the app.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
