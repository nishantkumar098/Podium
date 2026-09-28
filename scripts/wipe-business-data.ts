/**
 * Podium v2 — remove business records, keep the system.
 *
 * Written for the 2026-09-15 data-reset directive: the four source-of-truth
 * workbooks become the only origin of business data, so everything in the
 * database that no file backs is cleared and re-imported.
 *
 * "Business records" means the rows AMM's work creates: clients, leads,
 * projects, tasks, invoices, documents, the inventory ledger, chat. It does
 * NOT mean the system itself — the schema, the RBAC role and permission
 * definitions, the automation rules, the flow templates and playbooks, the
 * city list, the GST code table and the rest of the configuration all stay.
 * Both lists below are explicit and exhaustive: every table in the database
 * is named in exactly one of them, and the script refuses to run if the
 * schema has grown a table neither list mentions. A table nobody classified
 * is a table nobody decided about, and this is not a script that should be
 * guessing.
 *
 * SAFETY. Three independent gates, all of which must pass:
 *   1. PODIUM_ALLOW_BUSINESS_WIPE=1 must be set explicitly.
 *   2. The target database name must match --expect-db exactly, so a stale
 *      DATABASE_URL (the root .env points at podium_prod) cannot silently
 *      redirect the wipe.
 *   3. A fresh, restorable pg_dump for that database must exist under
 *      PODIUM_BACKUP_DIR, taken within PODIUM_BACKUP_MAX_AGE_H hours.
 *
 * Usage:
 *   pnpm tsx scripts/wipe-business-data.ts --expect-db=podium_dev --dry-run
 *   ... --wipe-identity      also clear user accounts (see IDENTITY_TABLES)
 *   PODIUM_ALLOW_BUSINESS_WIPE=1 pnpm tsx scripts/wipe-business-data.ts --expect-db=podium_dev
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Cleared. Ordered child-before-parent so the deletes succeed even where a
 * foreign key has no ON DELETE CASCADE.
 */
const BUSINESS_TABLES = [
  // --- event-day + operational leaf records
  "event_day_checkins", "event_day_incidents", "runsheet_items", "runsheets",
  "meeting_action_items", "meetings", "risks",
  // --- procurement
  "goods_receipts", "purchase_order_items", "purchase_orders", "purchase_requests",
  // --- finance
  "invoice_items", "credit_notes", "debit_notes", "payments", "invoices",
  "budget_lines", "budgets", "expenses",
  // --- documents + approvals
  "document_versions", "documents", "approvals",
  // --- work items + the flow engine's RUNTIME.
  // A FlowTemplate carries its step definitions inline, in its own `steps`
  // JSON column, so the flow_steps TABLE is not template data at all: every
  // row belongs to a FlowInstance, owned by a User, with a live status and
  // SLA clock. Same for flow_step_dependencies, which links two runtime
  // steps. Both are business records; only flow_templates is configuration.
  "task_dependencies", "tasks",
  "flow_step_runs", "flow_step_dependencies", "flow_steps", "flow_instances",
  // --- chat + notifications + mail
  "channel_members", "messages", "channels", "notifications", "emails",
  // --- inventory LEDGER (the item catalogue and locations are config)
  "inventory_reservations", "inventory_movements", "inventory_balances",
  // --- people-on-projects
  "project_vendors", "project_members", "projects",
  // --- compliance tied to a project
  "licences",
  // --- the sellable catalogue. Business data, not configuration: every row
  // is imported from a source workbook and re-derived on the next import, so
  // it belongs to the same "rebuild from the source of truth" contract as
  // clients and leads. The BRANDS that own them are configuration and stay.
  "products",
  // --- the CRM itself
  "client_contacts", "clients", "leads",
  // --- counterparties + crew
  "vendor_contacts", "vendors", "freelancers",
  // --- HR records
  "attendance", "leaves",
  // --- trail of the above
  "audit_logs", "automation_runs", "idempotency_keys",
];

/**
 * Identity. Business records by the directive's definition — the 15 accounts
 * currently in both databases are the seed fixture's invented people, backed
 * by no file — but cleared only with --wipe-identity, and deliberately NOT by
 * default.
 *
 * The reason is that the directive pairs the deletion with a replacement:
 * employees get real accounts created from the employee list. The employee
 * data in these workbooks ("AMM EMPLOYEE DATA", 177 rows) is a crew roster —
 * NAME / MOBILE NO / CATEGORY, where every category is BARTENDER, HOOKAH BOY
 * or FOOD CATERING — with no e-mail column anywhere in the sheet. E-mail is
 * the login identifier, so there is nothing to create accounts from, and
 * inventing 177 addresses for real people is the kind of guess this reset is
 * supposed to eliminate. Those 177 are already modelled correctly, as
 * Freelancers.
 *
 * So the delete half runs only when the create half is actually possible.
 * Doing the delete alone would leave a system nobody can log into and no
 * data to rebuild it from.
 */
const IDENTITY_TABLES = [
  "password_invites", "refresh_tokens", "google_accounts",
  "user_city_access", "user_roles", "users",
];

/**
 * Kept. System configuration, not business records — the directive names
 * most of these explicitly.
 */
const SYSTEM_TABLES = [
  "_prisma_migrations",
  "workspaces", "cities", "gst_state_codes", "invoice_counters",
  // Two trading entities under one LLP — a fixed fact about the business,
  // like its cities, not a record of work done.
  "brands",
  "permissions", "role_permissions", "roles",
  "automation_rules",
  "flow_templates", "playbooks",
  "sops", "sop_versions",
  "recipes", "recipe_items",
  "inventory_items", "inventory_locations",
];

const prisma = new PrismaClient();

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const DRY_RUN = process.argv.includes("--dry-run");
const WIPE_IDENTITY = process.argv.includes("--wipe-identity");
const EXPECT_DB = arg("expect-db");
const BACKUP_DIR = process.env.PODIUM_BACKUP_DIR ?? "/home/user/podium-backups/data-reset-20260915";
const BACKUP_MAX_AGE_H = Number(process.env.PODIUM_BACKUP_MAX_AGE_H ?? 24);

function fail(message: string): never {
  console.error(`\nREFUSING TO WIPE: ${message}\n`);
  process.exit(1);
}

/** Gate 3 — a wipe with no proven-restorable backup behind it is not allowed. */
function assertFreshRestorableBackup(dbName: string): string {
  if (!fs.existsSync(BACKUP_DIR)) fail(`no backup directory at ${BACKUP_DIR}`);
  const candidates = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(`${dbName}-`) && f.endsWith(".dump"))
    .map((f) => ({ file: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) fail(`no pg_dump for "${dbName}" in ${BACKUP_DIR}`);

  const newest = candidates[0]!;
  const ageH = (Date.now() - newest.mtime) / 3_600_000;
  if (ageH > BACKUP_MAX_AGE_H) fail(`newest backup for "${dbName}" is ${ageH.toFixed(1)}h old (limit ${BACKUP_MAX_AGE_H}h)`);

  // Present is not the same as restorable.
  try {
    execSync(`pg_restore --list ${JSON.stringify(newest.file)}`, { stdio: "pipe" });
  } catch {
    fail(`the backup ${newest.file} is not readable by pg_restore`);
  }
  return newest.file;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!dbName) fail("DATABASE_URL is not set");

  // Gate 2 — named explicitly, so the root .env's podium_prod default cannot
  // be inherited by accident. This is the exact mistake that wiped the dev
  // database on 2026-09-11.
  if (!EXPECT_DB) fail("--expect-db=<name> is required, and must match DATABASE_URL");
  if (EXPECT_DB !== dbName) fail(`DATABASE_URL points at "${dbName}" but --expect-db says "${EXPECT_DB}"`);

  // Every table must be classified.
  const live = (
    await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  ).map((r) => r.table_name);
  const classified = new Set([...BUSINESS_TABLES, ...IDENTITY_TABLES, ...SYSTEM_TABLES]);
  const unclassified = live.filter((t) => !classified.has(t));
  if (unclassified.length > 0) {
    fail(`the schema has ${unclassified.length} table(s) this script has never classified as business or system: ${unclassified.join(", ")}. Classify them before wiping.`);
  }
  const both = [...BUSINESS_TABLES, ...IDENTITY_TABLES].filter((t) => SYSTEM_TABLES.includes(t));
  if (both.length > 0) fail(`table(s) listed as BOTH business and system: ${both.join(", ")}`);

  const backup = assertFreshRestorableBackup(dbName);

  const countOf = async (table: string): Promise<number> => {
    const [{ count }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM "${table}"`);
    return Number(count);
  };

  console.log(`\n${"=".repeat(74)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}WIPE BUSINESS DATA — ${dbName}`);
  console.log(`${"=".repeat(74)}`);
  console.log(`backup in hand : ${backup}`);
  console.log(`tables         : ${BUSINESS_TABLES.length} business / ${SYSTEM_TABLES.length} system / ${live.length} total\n`);

  const TARGETS = WIPE_IDENTITY ? [...IDENTITY_TABLES, ...BUSINESS_TABLES] : BUSINESS_TABLES;

  let toDelete = 0;
  const nonEmpty: Array<[string, number]> = [];
  for (const table of TARGETS) {
    const n = await countOf(table);
    if (n > 0) nonEmpty.push([table, n]);
    toDelete += n;
  }
  console.log(`WILL DELETE ${toDelete.toLocaleString()} rows across ${nonEmpty.length} non-empty table(s):`);
  for (const [t, n] of nonEmpty) console.log(`   ${t.padEnd(26)} ${n.toLocaleString().padStart(9)}`);

  if (!WIPE_IDENTITY) {
    console.log(`\nWILL KEEP (identity — see IDENTITY_TABLES; pass --wipe-identity to include):`);
    for (const table of IDENTITY_TABLES) {
      const n = await countOf(table);
      if (n > 0) console.log(`   ${table.padEnd(26)} ${n.toLocaleString().padStart(9)}`);
    }
  }

  console.log(`\nWILL KEEP (system configuration):`);
  for (const table of SYSTEM_TABLES) {
    const n = await countOf(table);
    if (n > 0) console.log(`   ${table.padEnd(26)} ${n.toLocaleString().padStart(9)}`);
  }

  if (DRY_RUN) {
    console.log(`\nDry run — nothing was deleted.`);
    return;
  }

  // Gate 1.
  if (process.env.PODIUM_ALLOW_BUSINESS_WIPE !== "1") {
    fail("PODIUM_ALLOW_BUSINESS_WIPE=1 is not set");
  }

  // One transaction: either the whole business dataset goes, or none of it
  // does. A half-wiped database with dangling references is worse than both.
  await prisma.$transaction(async (tx) => {
    for (const table of TARGETS) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
  }, { timeout: 600_000 });

  console.log(`\nDeleted. Verifying every targeted table is now empty:`);
  let residue = 0;
  for (const table of TARGETS) {
    const n = await countOf(table);
    if (n > 0) {
      console.log(`   NOT EMPTY: ${table} = ${n}`);
      residue += n;
    }
  }
  console.log(residue === 0 ? `   all ${TARGETS.length} targeted tables are empty.` : `   ${residue} row(s) survived — investigate.`);
  if (residue > 0) process.exitCode = 1;

  console.log(`\nSystem configuration still present:`);
  for (const table of SYSTEM_TABLES) {
    const n = await countOf(table);
    if (n > 0) console.log(`   ${table.padEnd(26)} ${n.toLocaleString().padStart(9)}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
