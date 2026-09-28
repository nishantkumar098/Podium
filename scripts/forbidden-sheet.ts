/**
 * The one rule from the real-data import brief that is absolute:
 * `AMM_BRANDS_LLP_DATABASE.xlsx` contains a sheet of plaintext credentials,
 * and it must never be opened, read, parsed, or logged.
 *
 * The 2026-09-15 data-reset directive widened that rule from one category to
 * four — credentials, salary/compensation, bank/financial account details,
 * and government identity numbers — and from sheets to columns as well,
 * because an employee list carries those as columns inside an otherwise
 * perfectly importable sheet. Podium is an event-production OS, not a
 * payroll or KYC system: it has no schema for any of this and no business
 * reason to hold it.
 *
 * This lives in its own module with no dependencies so it can be imported and
 * tested without pulling in the import script (and its Prisma client, and its
 * destructive `main`).
 */

/**
 * Sheet-level patterns. A whole sheet matching one of these is a sheet whose
 * *subject* is sensitive — there is nothing importable to salvage from it.
 */
const FORBIDDEN_SHEET_PATTERNS: ReadonlyArray<RegExp> = [
  /PASSWORD/i,
  /CREDENTIAL/i,
  /\bLOGINS?\b/i,
  /SALAR/i,
  /PAYROLL/i,
  /\bCTC\b/i,
  /\bPAYSLIPS?\b/i,
  /BANK\s*(ACCOUNT|DETAIL)/i,
  /\bIFSC\b/i,
  /\bAADHA?A?R\b/i,
  /\bPAN\s*(CARD|NO|NUMBER)\b/i,
  /PASSPORT/i,
];

/**
 * Column-level patterns. Unlike sheets, a sensitive *column* sits alongside
 * columns we legitimately need (a name, a city, a role), so these are used to
 * drop the column and report it — not to refuse the whole sheet.
 *
 * Deliberately matched against the header cell only. No value from a dropped
 * column is ever read, so nothing sensitive can reach a log, a diff, or the
 * database even by accident.
 */
const SENSITIVE_COLUMN_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "credential", pattern: /PASSWORD|PASSCODE|CREDENTIAL|SECRET|\bOTP\b|\bPIN\b|\bAPI[\s_-]*KEY\b|\bTOKEN\b/i },
  // "F&F" (full and final settlement) columns carry an exiting employee's last
  // pay run — "F&F Gross", "Deductions/Recovery", "F&F Net Payable" sit side by
  // side in Master_Sheet.xlsx's "Exit & F&F" sheet, and only the last of those
  // matched on NET PAY. The settlement terms are matched rather than the sheet
  // name so the genuinely operational columns of an exit record (last working
  // day, asset recovery, access closure) stay importable.
  //
  // DEDUCTIONS? is the one pattern here with a plausible false positive in a
  // finance sheet. That is the intended trade: a column dropped in error is
  // named in the exclusion report and can be re-admitted deliberately, whereas
  // a payroll column read in error cannot be un-read.
  { label: "salary", pattern: /SALAR|\bCTC\b|PAYROLL|\bWAGE\b|\bSTIPEND\b|COMPENSATION|\bPAYSLIP\b|\bPF\b|\bESIC?\b|\bTDS\b|IN[\s-]*HAND|GROSS\s*PAY|NET\s*PAY|\bF\s*&\s*F\b|FULL\s*(AND|&)\s*FINAL|\bDEDUCTIONS?\b|\bARREARS?\b/i },
  // "BANK" alone is unusable here: Indian street addresses use bank branches
  // as landmarks constantly ("next to HDFC Bank"), and matching those would
  // exclude legitimate address columns wholesale. Require account context.
  { label: "bank-account", pattern: /BANK\s*(A\/?C|ACCT|ACCOUNT|NAME|DETAIL|BRANCH)|\bIFSC\b|\bACCOUNT\s*(NO\b|NUMBER|#)|\bA\/C\s*(NO|NUMBER)/i },
  // AADHAAR is transliterated a dozen ways in Indian office documents —
  // Aadhaar, Aadhar, Adhaar, Adhar, Aadar — and AMM's own employee master
  // spells it "Adhar Card". A pattern that insists on the canonical double-a
  // sails straight past a column of Aadhaar scan links, which is exactly what
  // happened on 2026-09-16. Match A(a)dh(a)(a)r in all its forms.
  { label: "government-id", pattern: /\bA+DH+A*R\b|\bPAN\b|\bUAN\b|PASSPORT|\bVOTER\s*ID\b|DRIV(ING|ER'?S)\s*(LICEN[CS]E)|\bSSN\b|\bNATIONAL\s*ID\b|\bGOVT?\.?\s*ID\b/i },
];

/**
 * Hard guard, not a filter. Anything that reaches a sheet whose name mentions
 * passwords is a bug in the caller, so this THROWS instead of skipping: a
 * silent skip would let a future refactor start reading credentials without
 * anyone noticing.
 */
export function assertNotForbidden(sheetName: string): void {
  if (isForbiddenSheet(sheetName)) {
    throw new Error(
      `Refusing to read a sensitive sheet ("${sheetName}"). This sheet must never be opened, parsed, or logged.`,
    );
  }
}

/** Non-throwing form, for callers that need to *enumerate* sheets before choosing which to read. */
export function isForbiddenSheet(sheetName: string): boolean {
  return FORBIDDEN_SHEET_PATTERNS.some((pattern) => pattern.test(sheetName));
}

/**
 * Which of the four categories a column header falls into, or null if the
 * column is safe to read. Returning the label (rather than a boolean) is what
 * lets the caller report *what* it excluded from *which* file, as the
 * directive requires — an exclusion nobody can see is not a real control.
 */
export function sensitiveColumnCategory(header: string): string | null {
  return SENSITIVE_COLUMN_PATTERNS.find(({ pattern }) => pattern.test(header))?.label ?? null;
}

export function isSensitiveColumn(header: string): boolean {
  return sensitiveColumnCategory(header) !== null;
}

/**
 * Resolve which COLUMN INDICES of a sheet must never be read.
 *
 * WHY THIS EXISTS. `sensitiveColumnCategory` only works if you hand it a real
 * header. AMM's workbooks frequently do not have one: `Master_Sheet.xlsx`'s
 * "Employee Deatils" sheet puts its titles in the first *data* row, so
 * `sheet_to_json` invents keys — `__EMPTY`, `__EMPTY_1`, `__EMPTY_5` — and a
 * header-only check sails straight past columns literally headed
 * "SALARY DETAILS", "Bank Details" and "Adhar Card".
 *
 * That happened on 2026-09-16 against 31 real employees. The guard was doing
 * exactly what it was told and was still wrong, because the assumption that
 * row 0 holds the header is not true of these files.
 *
 * So: scan the first `scanRows` rows, treat any short cell as a candidate
 * header, and block that column if ANY of them matches. Long cells are
 * skipped — a 100-character street address naming a bank branch is data, not
 * a header, and blocking on it would silently discard a legitimate column.
 *
 * Returns both the blocked indices and what was found, so an importer can
 * report exactly what it refused rather than dropping columns invisibly.
 */
export interface BlockedColumns {
  /** Column indices that must not be read. */
  indices: Set<number>;
  /** What matched, for the exclusion report: column index, the text, the category. */
  matches: Array<{ index: number; text: string; category: string }>;
}

/** Longest string still plausible as a column header; beyond this it is a value. */
const HEADER_MAX_CHARS = 40;

/**
 * Shapes that a column HEADING never has, and a data cell very often does.
 *
 * These exist because scanning cell *values* for header text is dangerous, and
 * the danger is not hypothetical: AMM's "INFLUENCER LIST" contains a real
 * person named **Sharnamli Adhaar**, and the "ANM BOOK BAR &REST" sheet lists
 * a bar whose website is **passcodeonly.com**. A naive value scan blocks the
 * name column of one and the website column of the other — silently deleting
 * two legitimate datasets to protect nothing.
 *
 * So a row is only treated as a possible heading row if NOTHING in it is
 * shaped like data. One phone number in the row is enough to disqualify it,
 * which is what separates those two sheets from the genuine heading row of
 * "Employee Deatils".
 */
const DATA_SHAPED: ReadonlyArray<RegExp> = [
  /^[-+₹$]?\s?[\d,]+(\.\d+)?%?$/, // an amount, a count, a percentage
  /^\+?\d[\d\s()./-]{5,}$/, // a phone number, however it is spaced
  /^(https?:\/\/|www\.)/i, // a link
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/, // an e-mail address
  /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/, // a date
];

function normalizeCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return "0000-00-00"; // data-shaped by construction
  return String(cell).replace(/\s+/g, " ").trim();
}

/**
 * Does this row read as a row of column headings rather than a row of records?
 *
 * Deliberately strict — every filled cell must be short, and none may be
 * shaped like data. A heading row that genuinely contains a bare year ("2026")
 * will be skipped by this, which is the accepted cost of not blocking a real
 * column on the strength of one person's surname.
 */
function looksLikeHeaderRow(cells: ReadonlyArray<unknown>): boolean {
  let filled = 0;
  for (const cell of cells) {
    const text = normalizeCell(cell);
    if (!text) continue;
    filled += 1;
    if (text.length > HEADER_MAX_CHARS) return false;
    if (DATA_SHAPED.some((shape) => shape.test(text))) return false;
  }
  return filled >= 2;
}

export function blockedColumnsIn(grid: ReadonlyArray<ReadonlyArray<unknown>>, scanRows = 3): BlockedColumns {
  const indices = new Set<number>();
  const matches: BlockedColumns["matches"] = [];

  for (const row of grid.slice(0, scanRows)) {
    if (!row || !looksLikeHeaderRow(row)) continue;
    row.forEach((cell, index) => {
      const category = sensitiveColumnCategory(normalizeCell(cell));
      if (!category) return;
      indices.add(index);
      matches.push({ index, text: normalizeCell(cell), category });
    });
  }
  return { indices, matches };
}

/**
 * The same protection for a HEADER-KEYED read.
 *
 * `sheet_to_json` without `header: 1` returns `Record<string, unknown>` keyed
 * by row 0. When row 0 is not the real header, the keys are `__EMPTY_1`-style
 * placeholders and the titles ("SALARY DETAILS", "Adhar Card") appear as
 * VALUES in the first data rows. Checking the keys alone is then worthless —
 * which is exactly how three sensitive columns of AMM's employee master were
 * read on 2026-09-16.
 *
 * So a key is blocked if the key itself is sensitive, OR any of the first
 * `scanRows` values under it reads like a sensitive header.
 */
export interface BlockedKeys {
  /** Object keys whose values must not be read. */
  keys: Set<string>;
  /** What matched, for the exclusion report: the key, the text that matched, the category. */
  matches: Array<{ key: string; text: string; category: string }>;
}

export function blockedKeysIn(
  rows: ReadonlyArray<Record<string, unknown>>,
  scanRows = 3,
): BlockedKeys {
  const keys = new Set<string>();
  const matches: BlockedKeys["matches"] = [];
  const record = (key: string, text: string, category: string) => {
    keys.add(key);
    matches.push({ key, text, category });
  };

  for (const key of rows.length > 0 ? Object.keys(rows[0]!) : []) {
    const category = sensitiveColumnCategory(key);
    if (category) record(key, key, category);
  }

  for (const row of rows.slice(0, scanRows)) {
    const entries = Object.entries(row);
    if (!looksLikeHeaderRow(entries.map(([, value]) => value))) continue;
    for (const [key, value] of entries) {
      const text = normalizeCell(value);
      const category = sensitiveColumnCategory(text);
      if (category) record(key, text, category);
    }
  }
  return { keys, matches };
}
