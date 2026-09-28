/**
 * Read-only structural analysis of the 2026-09-15 source-of-truth workbooks.
 *
 * Writes nothing and touches no database. Its only job is to answer "what is
 * actually in these files, and what must never be read out of them" before a
 * single line of import or deletion code gets written.
 *
 * Two-pass read, deliberately: pass one asks the workbook for sheet NAMES only
 * (`bookSheets`), pass two re-opens it parsing ONLY the sheets that cleared the
 * guard (`sheets: [...]`). A forbidden sheet is therefore never decompressed
 * into memory at all — stronger than parsing everything and then declining to
 * print it.
 *
 * Usage:  pnpm tsx scripts/analyze-source-files.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { blockedKeysIn, isForbiddenSheet } from "./forbidden-sheet";

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";

const FILES = [
  { label: "event-calendar", file: "0e936dc5-AMM_Event_Calender_for_Staff.xlsx" },
  { label: "database-export", file: "f4544bcd-AMM_BRANDS_LLP_DATABASE_1.xlsx" },
  { label: "sales-funnel", file: "8d3abe94-Elixir_New_Clients_Query_1.xlsx" },
];

/** Sample values are echoed to prove a column's shape; cap them so nothing dumps a whole sheet. */
const SAMPLES = 3;
const SAMPLE_CHARS = 60;

function preview(value: unknown): string {
  if (value === null || value === undefined || value === "") return "∅";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
}

for (const { label, file } of FILES) {
  const full = path.join(UPLOADS, file);
  const bytes = fs.statSync(full).size;
  console.log(`\n${"=".repeat(78)}\n${label}  —  ${file}  (${(bytes / 1024).toFixed(0)} KB)\n${"=".repeat(78)}`);

  // Pass 1: names only. Nothing is parsed yet.
  const names: string[] = XLSX.readFile(full, { bookSheets: true }).SheetNames;
  const allowed = names.filter((n) => !isForbiddenSheet(n));
  const refused = names.filter((n) => isForbiddenSheet(n));

  console.log(`sheets: ${names.length} total, ${allowed.length} readable, ${refused.length} refused`);
  for (const name of refused) console.log(`  REFUSED SHEET  "${name}"  — never opened or parsed`);

  // Pass 2: parse only what cleared the guard.
  const book = XLSX.readFile(full, { sheets: allowed, cellDates: true });

  for (const name of allowed) {
    const sheet = book.Sheets[name];
    if (!sheet) {
      console.log(`\n  -- "${name}" -- (empty)`);
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];

    // Not `sensitiveColumnCategory(header)`: half of AMM's sheets put their
    // real titles in a data row, so the keys here are `__EMPTY_n` and a
    // header-only check reads salary and Aadhaar columns believing the sheet
    // is clean. `blockedKeysIn` looks at the heading row wherever it is.
    const { keys: blocked, matches } = blockedKeysIn(rows, 3);
    const safe = headers.filter((h) => !blocked.has(h));

    console.log(`\n  -- "${name}" -- ${rows.length} data rows, ${headers.length} columns`);
    for (const m of matches) {
      console.log(`     EXCLUDED COLUMN  "${m.key}" (heading "${m.text}")  [${m.category}] — values never read`);
    }

    for (const header of safe) {
      const filled = rows.filter((r) => r[header] !== null && r[header] !== "");
      const samples = filled.slice(0, SAMPLES).map((r) => preview(r[header]));
      const pct = rows.length > 0 ? Math.round((filled.length / rows.length) * 100) : 0;
      console.log(`     ${header.padEnd(34).slice(0, 34)} ${String(pct).padStart(3)}% filled | ${samples.join(" | ")}`);
    }
  }
}
