/**
 * Podium v2 — reconciliation of live business data against the 2026-09-15
 * source-of-truth workbooks.
 *
 * READ-ONLY. This script opens a database connection and writes nothing. It
 * exists to answer one question before anything is deleted: which live
 * records would stop being backed by a real file, and are therefore
 * candidates for removal?
 *
 * Method — deliberately conservative in the direction of keeping data.
 * Rather than re-deriving the importer's per-sheet parsing (which would drift
 * from it over time and quietly mis-scope a deletion), this builds a *key
 * universe*: every phone number, e-mail address and name appearing in ANY
 * readable cell of ANY non-forbidden sheet across all source files. A live
 * record counts as backed if any one of its identifiers appears anywhere in
 * that universe.
 *
 * That deliberately over-matches. A record the files mention only in passing
 * is still counted as backed, because the cost of wrongly keeping a row is a
 * stale row someone can delete later, and the cost of wrongly dropping one is
 * a real client AMM can never get back.
 *
 * Records that match on one identifier but not another — the name is there,
 * the phone isn't — are reported SEPARATELY as `near`. Those are
 * reconciliation problems for a human to look at, never grounds for deletion.
 *
 * Usage:
 *   DATABASE_URL=postgresql://.../podium_prod pnpm tsx scripts/reconcile-source-of-truth.ts
 *   ... --json=/path/to/report.json      also write the full machine-readable diff
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { blockedColumnsIn, isForbiddenSheet } from "./forbidden-sheet";
import { normalizePhone } from "./import-real-data";

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";

const SOURCE_FILES = [
  { label: "event calendar", file: "0e936dc5-AMM_Event_Calender_for_Staff.xlsx" },
  { label: "database export", file: "f4544bcd-AMM_BRANDS_LLP_DATABASE_1.xlsx" },
  { label: "sales funnel", file: "8d3abe94-Elixir_New_Clients_Query_1.xlsx" },
];

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Key normalization — one definition, used for both sides of the diff.
// ---------------------------------------------------------------------------

const normName = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    // Trailing qualifiers AMM adds to names ("... bar client 24th june").
    .replace(/\b(BAR|EVENT|FOOD|HOOKAH)?\s*CLIENT\b.*$/i, "")
    .replace(/[^A-Z0-9 &.]/g, "")
    .trim();
  // One- or two-character residues match far too much to be evidence.
  return s.length >= 3 ? s : null;
};

const normEmail = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

const normPhone = (v: unknown): string | null => normalizePhone(v).phone;

// ---------------------------------------------------------------------------
// Build the key universe from the files.
// ---------------------------------------------------------------------------

interface Universe {
  phones: Set<string>;
  emails: Set<string>;
  names: Set<string>;
  /** What was refused or dropped, for the exclusion report the directive requires. */
  exclusions: Array<{ file: string; sheet: string; kind: "sheet" | "column"; what: string; category: string }>;
  sheetsRead: number;
  cellsScanned: number;
}

function buildUniverse(): Universe {
  const u: Universe = {
    phones: new Set(),
    emails: new Set(),
    names: new Set(),
    exclusions: [],
    sheetsRead: 0,
    cellsScanned: 0,
  };

  for (const { file } of SOURCE_FILES) {
    const full = path.join(UPLOADS, file);
    const names: string[] = XLSX.readFile(full, { bookSheets: true }).SheetNames;
    const allowed = names.filter((n) => !isForbiddenSheet(n));
    for (const refused of names.filter((n) => isForbiddenSheet(n))) {
      u.exclusions.push({ file, sheet: refused, kind: "sheet", what: refused, category: "credential" });
    }

    const book = XLSX.readFile(full, { sheets: allowed, cellDates: true });
    for (const sheet of allowed) {
      const ws = book.Sheets[sheet];
      if (!ws) continue;
      u.sheetsRead++;
      const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
      if (grid.length === 0) continue;

      /**
       * These workbooks put their real header anywhere in the first three
       * rows (merged group headers sit above it in the calendar sheets), so
       * sensitive-column detection scans all of them rather than trusting
       * row 0 — a salary column hiding under a merged header must still be
       * excluded.
       *
       * This used to be a hand-rolled copy of that scan. It is now the shared
       * guard: the copy is what let three sensitive columns of the HR master
       * through on 2026-09-16, because a fix applied in one place never
       * reached the other.
       */
      const { indices: blocked, matches } = blockedColumnsIn(grid, 3);
      for (const m of matches) {
        u.exclusions.push({ file, sheet, kind: "column", what: m.text, category: m.category });
      }

      for (const row of grid) {
        (row as unknown[]).forEach((cellValue, colIdx) => {
          if (cellValue === null || blocked.has(colIdx)) return;
          u.cellsScanned++;
          const value = String(cellValue);
          const phone = normPhone(value);
          if (phone) u.phones.add(phone);
          const email = normEmail(value);
          if (email) u.emails.add(email);
          const name = normName(value);
          if (name) u.names.add(name);
        });
      }
    }
  }
  return u;
}

// ---------------------------------------------------------------------------
// Diff one entity against the universe.
// ---------------------------------------------------------------------------

interface Record_ {
  id: string;
  label: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  extra?: string;
}

interface EntityResult {
  entity: string;
  total: number;
  backed: number;
  near: Record_[];
  unmatched: Record_[];
}

function diffEntity(entity: string, rows: Record_[], u: Universe): EntityResult {
  const near: Record_[] = [];
  const unmatched: Record_[] = [];
  let backed = 0;

  for (const r of rows) {
    const phone = normPhone(r.phone);
    const email = normEmail(r.email);
    const name = normName(r.name);

    const phoneHit = phone !== null && u.phones.has(phone);
    const emailHit = email !== null && u.emails.has(email);
    const nameHit = name !== null && u.names.has(name);

    if (phoneHit || emailHit) {
      // A phone or e-mail match is an identity match — strong evidence.
      backed++;
    } else if (nameHit) {
      // The person/company is in the files, but the contact detail we hold
      // isn't. That is a reconciliation problem (renamed, re-numbered, typo),
      // never a reason to delete.
      const held = [phone ? `phone ${phone}` : null, email ? `email ${email}` : null].filter(Boolean).join(" and ");
      near.push({ ...r, extra: held ? `name is in the files, but the ${held} we hold is not` : "name is in the files; we hold no phone or e-mail to confirm it" });
    } else {
      unmatched.push(r);
    }
  }
  return { entity, total: rows.length, backed, near, unmatched };
}

// ---------------------------------------------------------------------------

async function main() {
  const jsonArg = process.argv.find((a) => a.startsWith("--json="));
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";

  console.log(`\n${"=".repeat(78)}`);
  console.log(`RECONCILIATION — database: ${dbName}`);
  console.log(`${"=".repeat(78)}`);

  const u = buildUniverse();
  console.log(`\nKey universe built from ${SOURCE_FILES.length} files / ${u.sheetsRead} sheets / ${u.cellsScanned.toLocaleString()} cells:`);
  console.log(`  distinct phones: ${u.phones.size.toLocaleString()}`);
  console.log(`  distinct emails: ${u.emails.size.toLocaleString()}`);
  console.log(`  distinct names:  ${u.names.size.toLocaleString()}`);

  console.log(`\nEXCLUDED AS SENSITIVE (never opened, parsed, or logged):`);
  const seen = new Set<string>();
  for (const e of u.exclusions) {
    const k = `${e.file}|${e.sheet}|${e.what}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  [${e.category}] ${e.kind} "${e.what}" — ${e.file}${e.kind === "column" ? ` :: "${e.sheet}"` : ""}`);
  }
  if (u.exclusions.length === 0) console.log(`  (none matched)`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("No workspace found — is DATABASE_URL pointing at a real Podium database?");

  const results: EntityResult[] = [];

  const clients = await prisma.client.findMany({ select: { id: true, name: true, phone: true, phoneRaw: true, email: true } });
  results.push(diffEntity("clients", clients.map((c) => ({ id: c.id, label: c.name, phone: c.phone ?? c.phoneRaw, email: c.email, name: c.name })), u));

  const leads = await prisma.lead.findMany({ select: { id: true, name: true, contactName: true, phone: true, phoneRaw: true, email: true } });
  results.push(diffEntity("leads", leads.map((l) => ({ id: l.id, label: l.contactName ?? l.name ?? l.id, phone: l.phone ?? l.phoneRaw, email: l.email, name: l.contactName ?? l.name })), u));

  const vendors = await prisma.vendor.findMany({ select: { id: true, name: true, contactName: true, phone: true, email: true } });
  results.push(diffEntity("vendors", vendors.map((v) => ({ id: v.id, label: v.name, phone: v.phone, email: v.email, name: v.name })), u));

  const freelancers = await prisma.freelancer.findMany({ select: { id: true, name: true, phone: true } });
  results.push(diffEntity("freelancers", freelancers.map((f) => ({ id: f.id, label: f.name, phone: f.phone, email: null, name: f.name })), u));

  const projects = await prisma.project.findMany({ select: { id: true, name: true } });
  results.push(diffEntity("projects", projects.map((p) => ({ id: p.id, label: p.name, phone: null, email: null, name: p.name })), u));

  console.log(`\n${"-".repeat(78)}\nPER-ENTITY DIFF\n${"-".repeat(78)}`);
  for (const r of results) {
    const pct = r.total ? Math.round((r.backed / r.total) * 100) : 0;
    console.log(`\n${r.entity}: ${r.total.toLocaleString()} live rows`);
    console.log(`  backed by a phone/e-mail in the new files : ${r.backed.toLocaleString()} (${pct}%)`);
    console.log(`  near-match, FLAGGED not deleted           : ${r.near.length.toLocaleString()}`);
    console.log(`  no match anywhere — WOULD BE LOST         : ${r.unmatched.length.toLocaleString()}`);
    for (const n of r.near.slice(0, 5)) console.log(`     near: ${n.label} — ${n.extra}`);
    for (const x of r.unmatched.slice(0, 10)) console.log(`     LOST: ${x.label}${x.phone ? ` / ${x.phone}` : ""}${x.email ? ` / ${x.email}` : ""}`);
    if (r.unmatched.length > 10) console.log(`     ... and ${r.unmatched.length - 10} more (see --json for the full list)`);
  }

  // Business records with no natural key to reconcile at all — reported so the
  // wipe's blast radius is stated in full rather than implied.
  const collateral = {
    projects: await prisma.project.count(),
    tasks: await prisma.task.count(),
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
    expenses: await prisma.expense.count(),
    purchaseRequests: await prisma.purchaseRequest.count(),
    approvals: await prisma.approval.count(),
    documents: await prisma.document.count(),
    flowInstances: await prisma.flowInstance.count(),
    messages: await prisma.message.count(),
    attendance: await prisma.attendance.count(),
    users: await prisma.user.count(),
  };
  console.log(`\n${"-".repeat(78)}\nDEPENDENT RECORDS WITH NO SOURCE-FILE KEY (deleted as collateral, if their parent goes)\n${"-".repeat(78)}`);
  for (const [k, v] of Object.entries(collateral)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(8)}`);

  if (jsonArg) {
    const out = jsonArg.slice("--json=".length);
    fs.writeFileSync(out, JSON.stringify({ database: dbName, generatedAt: new Date().toISOString(), universe: { phones: u.phones.size, emails: u.emails.size, names: u.names.size }, exclusions: [...seen], results, collateral }, null, 2));
    console.log(`\nFull machine-readable diff written to ${out}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
