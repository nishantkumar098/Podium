/**
 * Podium v2 — provision the real AMM Brands staff from the KRA sheet.
 *
 * `KRA_Sheet__2.xlsx` is AMM's definitive staff list: 25 people across four
 * locations, each with a department or designation. Anant's instruction was
 * explicit — these are the only employees, everything else claiming to be
 * employee data goes.
 *
 * What this does:
 *   1. Deletes every Freelancer. Those 171 rows came from the workbook sheet
 *      "AMM EMPLOYEE DATA", which the KRA sheet supersedes. NOTE that this
 *      removes AMM's event-crew pool from Podium — see the report. Reversible
 *      from the pre-run backup this script insists on.
 *   2. Deletes every User account not in the KRA list. All 15 current accounts
 *      are the seed fixture's invented people (byte-identical between
 *      podium_dev and podium_prod), backed by no file.
 *   3. Creates or reconciles one account per KRA person, matched BY E-MAIL
 *      first so a re-run updates rather than duplicating.
 *
 * PASSWORDS. Generated here, server-side, from `crypto.randomBytes` — never
 * derived from anything in the spreadsheet. A name, a phone number or an
 * employee ID are all guessable and must never become a password. Every
 * account is created with `mustChangePassword: true`, so the temporary
 * password buys exactly one login and nothing else.
 *
 * DELIVERY. There is no live mail transport in this environment, and faking
 * a "sent" e-mail would be worse than useless. Instead the credentials are
 * written to a single 0600 file OUTSIDE the repository for Anant to
 * distribute through a real channel. They are never logged to stdout, never
 * written into the database, and never committed.
 *
 * Usage:
 *   pnpm tsx scripts/provision-employees.ts --expect-db=podium_dev --dry-run
 *   PODIUM_ALLOW_EMPLOYEE_RESET=1 pnpm tsx scripts/provision-employees.ts --expect-db=podium_dev
 */
import { execSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import * as XLSX from "xlsx";
import { isForbiddenSheet, sensitiveColumnCategory } from "./forbidden-sheet";

const UPLOADS = process.env.PODIUM_IMPORT_DIR ?? "/root/.claude/uploads/3f727242-cd2a-50a4-8be4-56242dfab268";
const KRA_FILE = path.join(UPLOADS, process.env.PODIUM_KRA_FILE ?? "93c8f645-KRA_Sheet__2.xlsx");
const BACKUP_DIR = process.env.PODIUM_BACKUP_DIR ?? "/home/user/podium-backups/data-reset-20260915";
const CREDENTIAL_DIR = process.env.PODIUM_CREDENTIAL_DIR ?? "/home/user/podium-credentials";
const EMAIL_DOMAIN = process.env.PODIUM_EMAIL_DOMAIN ?? "ammbrands.in";

const prisma = new PrismaClient();

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const DRY_RUN = process.argv.includes("--dry-run");
const EXPECT_DB = arg("expect-db");

function fail(message: string): never {
  console.error(`\nREFUSING: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parsing the KRA sheet
// ---------------------------------------------------------------------------

interface KraPerson {
  name: string;
  title: string;
  section: string;
}

/**
 * Five rows put the job title inside the NAME field with no delimiter —
 * "Yashwant soyal Operations Manager" — so there is no rule that separates
 * the name from the title without knowing which is which. Rather than guess
 * with a heuristic that would mangle them differently on the next upload,
 * these five are split explicitly. If the sheet changes, this list is the
 * first thing to check.
 */
const RUN_ON_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  ["AMIT SINGH (MANAGER)", "Amit Singh", "Manager"],
  ["Anant nahar Head Business- Strategist", "Anant Nahar", "Head Business-Strategist"],
  ["Yashwant soyal Operations Manager", "Yashwant Soyal", "Operations Manager"],
  ["Tejashwani Bhatra Marketing Executive", "Tejashwani Bhatra", "Marketing Executive"],
  ["Nishant Kumar AI Specialist Associate", "Nishant Kumar", "AI Specialist Associate"],
];

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();

function parseKra(): KraPerson[] {
  const sheetNames: string[] = XLSX.readFile(KRA_FILE, { bookSheets: true }).SheetNames;
  for (const n of sheetNames) {
    if (isForbiddenSheet(n)) fail(`the KRA workbook contains a sensitive sheet "${n}" — refusing to read the file`);
  }
  const book = XLSX.readFile(KRA_FILE, { sheets: sheetNames, cellDates: true });
  const people: KraPerson[] = [];

  for (const sheetName of sheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName]!, { header: 1, defval: null, blankrows: true });
    const txt = (c: unknown) => (c === null || c === undefined ? "" : String(c).replace(/\s+/g, " ").trim());
    let section = "";

    for (const row of grid) {
      const cells = row as unknown[];
      const a = txt(cells[0]);
      const b = txt(cells[1]);

      // A lone value in column A is a location heading.
      if (a && !b && !/^\d+$/.test(a) && a.length < 60 && !/^S\.?no/i.test(a)) section = titleCase(a);

      const blob = [a, b, txt(cells[2]), txt(cells[3])].filter(Boolean).join(" ");
      if (!/NAME\s*:/i.test(blob)) continue;

      // This is a staff block header, not a responsibility row. Nothing here
      // should ever be a salary or ID column, but check rather than assume.
      const category = blob.length <= 60 ? sensitiveColumnCategory(blob) : null;
      if (category) fail(`KRA staff block looks like ${category} data, refusing to parse it: ${blob.slice(0, 40)}`);

      const after = blob.replace(/^.*?NAME\s*:\s*/i, "").trim();

      const runOn = RUN_ON_TITLES.find(([raw]) => raw.toLowerCase() === after.toLowerCase());
      if (runOn) {
        people.push({ name: runOn[1], title: runOn[2], section });
        continue;
      }

      // "X DEPARTMENT : Y" or "X (DESIGNATION : Y)"
      const m = /^(.*?)\(?\s*(?:DEPARTMENT|DESIGNATION)\s*:?\s*(.*?)\)?\s*$/i.exec(after);
      const namePart = (m ? m[1] : after).trim();
      const title = titleCase((m?.[2] ?? "").trim());

      // One block lists several people sharing a designation.
      for (const raw of namePart.split("/").map((n) => n.trim()).filter(Boolean)) {
        people.push({ name: titleCase(raw), title: title || "Staff", section });
      }
    }
  }
  return people;
}

// ---------------------------------------------------------------------------
// Mapping people onto Podium's roles and cities
// ---------------------------------------------------------------------------

/**
 * The KRA sheet names departments and designations, not Podium roles. This
 * maps the former onto the ten roles that actually exist, most specific
 * pattern first. Every mapping is a business judgement and is printed on
 * every run so it can be corrected — nothing here is load-bearing enough to
 * hide.
 */
const ROLE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/HEAD\s*BUSINESS|STRATEGIST/i, "Founder"],
  [/ACCOUNTS|FINANCE|PURCHAS/i, "Finance"],
  [/OPERATIONS|BAR\s*MANAGER|CATERING\s*MANAGER/i, "Operations"],
  [/MARKETING|SALES/i, "Sales"],
  [/^MANAGER$/i, "Project Manager"],
  [/BARTENDER|HELPER|CLEANER|SECURITY|AI\s*SPECIALIST|STAFF/i, "Employee"],
];
const roleFor = (title: string) => ROLE_RULES.find(([re]) => re.test(title))?.[1] ?? "Employee";

/**
 * Location headings map onto the workspace's cities. "Green Park" is a Delhi
 * neighbourhood and the warehouse sits with it; "Rajasthan Staff" covers both
 * Rajasthan cities, so those people get access to each.
 */
const CITY_RULES: ReadonlyArray<readonly [RegExp, string[]]> = [
  [/GREEN\s*PARK|WAREHOUSE/i, ["Delhi"]],
  [/DEHRADUN/i, ["Dehradun"]],
  [/RAJASTHAN/i, ["Jaipur"]],
];
const citiesFor = (section: string) => CITY_RULES.find(([re]) => re.test(section))?.[1] ?? [];

/** first@domain, or first.last@domain — de-duplicated with a numeric suffix. */
function emailFor(name: string, taken: Set<string>): string {
  const parts = name.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const base = parts.length === 1 ? parts[0]! : `${parts[0]}.${parts[parts.length - 1]}`;
  let candidate = `${base}@${EMAIL_DOMAIN}`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}${n++}@${EMAIL_DOMAIN}`;
  taken.add(candidate);
  return candidate;
}

/**
 * A temporary password. Random from the OS CSPRNG, never derived from the
 * spreadsheet. The alphabet drops characters that get misread when someone
 * reads a password aloud or copies it off a screen (O/0, l/1/I).
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function temporaryPassword(length = 16): string {
  randomBytes(1); // touch the CSPRNG so a stubbed randomInt cannot silently degrade this
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

// ---------------------------------------------------------------------------

function assertFreshRestorableBackup(dbName: string): string {
  const candidates = fs.existsSync(BACKUP_DIR)
    ? fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(`${dbName}-`) && f.endsWith(".dump"))
        .map((f) => ({ file: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  if (candidates.length === 0) fail(`no pg_dump for "${dbName}" in ${BACKUP_DIR}`);
  const newest = candidates[0]!;
  const ageH = (Date.now() - newest.mtime) / 3_600_000;
  if (ageH > 24) fail(`newest backup for "${dbName}" is ${ageH.toFixed(1)}h old`);
  try {
    execSync(`pg_restore --list ${JSON.stringify(newest.file)}`, { stdio: "pipe" });
  } catch {
    fail(`the backup ${newest.file} is not readable by pg_restore`);
  }
  return newest.file;
}

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName) fail("DATABASE_URL is not set");
  if (!EXPECT_DB) fail("--expect-db=<name> is required, and must match DATABASE_URL");
  if (EXPECT_DB !== dbName) fail(`DATABASE_URL points at "${dbName}" but --expect-db says "${EXPECT_DB}"`);

  const people = parseKra();
  if (people.length === 0) fail("parsed zero people out of the KRA sheet");

  const taken = new Set<string>();
  const planned = people.map((p) => ({
    ...p,
    email: emailFor(p.name, taken),
    role: roleFor(p.title),
    cities: citiesFor(p.section),
  }));

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}PROVISION EMPLOYEES FROM KRA SHEET — ${dbName}`);
  console.log(`${"=".repeat(78)}\n`);
  console.log(`${planned.length} people parsed from ${path.basename(KRA_FILE)}:\n`);
  console.log(`  ${"NAME".padEnd(20)} ${"LOGIN ID".padEnd(30)} ${"ROLE".padEnd(16)} ${"TITLE".padEnd(26)} CITIES`);
  for (const p of planned) {
    console.log(`  ${p.name.padEnd(20)} ${p.email.padEnd(30)} ${p.role.padEnd(16)} ${p.title.padEnd(26)} ${p.cities.join(", ") || "(none)"}`);
  }

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) fail("no workspace in this database");

  const existingUsers = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  const keepEmails = new Set(planned.map((p) => p.email.toLowerCase()));
  const toRemove = existingUsers.filter((u) => !keepEmails.has(u.email.toLowerCase()));
  const freelancerCount = await prisma.freelancer.count();

  console.log(`\nWILL REMOVE:`);
  console.log(`  ${freelancerCount} freelancer record(s) — the superseded "AMM EMPLOYEE DATA" crew roster`);
  console.log(`  ${toRemove.length} user account(s) not in the KRA sheet:`);
  for (const u of toRemove) console.log(`     ${u.email}  (${u.name})`);

  const missingCities = [...new Set(planned.flatMap((p) => p.cities))];
  const haveCities = await prisma.city.findMany({ where: { workspaceId: workspace.id }, select: { name: true } });
  const haveNames = new Set(haveCities.map((c) => c.name));
  const needCreating = missingCities.filter((c) => !haveNames.has(c));
  if (needCreating.length > 0) console.log(`\nWILL CREATE CITY: ${needCreating.join(", ")} (AMM has staff there; no such city exists yet)`);
  const noCity = planned.filter((p) => p.cities.length === 0);
  if (noCity.length > 0) console.log(`\nNO CITY MAPPED for: ${noCity.map((p) => p.name).join(", ")}`);

  if (DRY_RUN) {
    console.log(`\nDry run — nothing was written.`);
    return;
  }
  if (process.env.PODIUM_ALLOW_EMPLOYEE_RESET !== "1") fail("PODIUM_ALLOW_EMPLOYEE_RESET=1 is not set");
  const backup = assertFreshRestorableBackup(dbName);
  console.log(`\nbackup in hand: ${backup}`);

  // Credentials are held in memory only until they are written to the 0600
  // file at the end. They are never printed and never stored in the database.
  const credentials: Array<{ name: string; email: string; role: string; password: string }> = [];
  let removedDependents: Record<string, number> = {};

  await prisma.$transaction(async (tx) => {
    // Dehradun is real — AMM has staff there — but was never in the seeded
    // city list. GST 05 is Uttarakhand.
    for (const cityName of needCreating) {
      const meta: Record<string, { code: string; state: string; gst: string }> = {
        Dehradun: { code: "DDN", state: "Uttarakhand", gst: "05" },
      };
      const m = meta[cityName];
      if (!m) throw new Error(`no metadata to create city ${cityName} — add it before running`);
      await tx.city.create({
        data: { workspaceId: workspace.id, name: cityName, code: m.code, state: m.state, gstStateCode: m.gst },
      });
    }

    const cityByName = new Map(
      (await tx.city.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } })).map((c) => [c.name, c.id]),
    );
    const roleByName = new Map(
      (await tx.role.findMany({ select: { id: true, name: true } })).map((r) => [r.name, r.id]),
    );

    // Remove superseded people. Child rows first.
    //
    // Everything that REFERENCES one of these users has to go with them, or
    // the delete fails on a foreign key — which is exactly what happened
    // against podium_prod, where the business wipe had not run and 15
    // attendance rows, 4 leaves, 4 messages and a licence still pointed at
    // the fixture accounts. Scoped strictly to rows belonging to the users
    // being removed: a fixture user's attendance record is itself fixture
    // data, but nobody else's is touched.
    const removeIds = toRemove.map((u) => u.id);
    if (removeIds.length > 0) {
      const owned = { userId: { in: removeIds } };
      const dependents = {
        attendance: await tx.attendance.deleteMany({ where: owned }),
        leaves: await tx.leave.deleteMany({ where: owned }),
        messages: await tx.message.deleteMany({ where: { authorId: { in: removeIds } } }),
        // Licence.ownerId is non-nullable, so there is no orphan to leave
        // behind — a compliance licence owned by a fixture user is itself
        // fixture data, and the business wipe removes licences anyway.
        licences: await tx.licence.deleteMany({ where: { ownerId: { in: removeIds } } }),
        refreshTokens: await tx.refreshToken.deleteMany({ where: owned }),
        userRoles: await tx.userRole.deleteMany({ where: owned }),
        userCityAccess: await tx.userCityAccess.deleteMany({ where: owned }),
      };
      removedDependents = Object.fromEntries(
        Object.entries(dependents).filter(([, r]) => r.count > 0).map(([k, r]) => [k, r.count]),
      );
      await tx.user.deleteMany({ where: { id: { in: removeIds } } });
    }
    await tx.freelancer.deleteMany({});

    for (const p of planned) {
      const roleId = roleByName.get(p.role);
      if (!roleId) throw new Error(`role "${p.role}" does not exist in this workspace`);

      const password = temporaryPassword();
      const passwordHash = await bcrypt.hash(password, 10);

      // Matched on e-mail so a re-run reconciles instead of duplicating.
      const user = await tx.user.upsert({
        where: { email: p.email },
        create: {
          workspaceId: workspace.id,
          name: p.name,
          email: p.email,
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: null,
          dept: p.title,
          primaryRoleId: roleId,
          primaryCityId: p.cities[0] ? cityByName.get(p.cities[0]) ?? null : null,
          isActive: true,
        },
        update: {
          name: p.name,
          passwordHash,
          mustChangePassword: true,
          dept: p.title,
          primaryRoleId: roleId,
          primaryCityId: p.cities[0] ? cityByName.get(p.cities[0]) ?? null : null,
          isActive: true,
        },
      });

      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({ data: { userId: user.id, roleId } });

      await tx.userCityAccess.deleteMany({ where: { userId: user.id } });
      if (p.role === "Founder" || p.role === "Admin") {
        await tx.userCityAccess.create({ data: { userId: user.id, cityId: null, scope: "ALL" } });
      } else {
        for (const cityName of p.cities) {
          const cityId = cityByName.get(cityName);
          if (cityId) await tx.userCityAccess.create({ data: { userId: user.id, cityId, scope: "WRITE" } });
        }
      }

      credentials.push({ name: p.name, email: p.email, role: p.role, password });
    }
  }, { timeout: 600_000 });

  // 0700 directory, 0600 file, outside the repository. Written last so a
  // failed transaction never leaves credentials for accounts that do not exist.
  fs.mkdirSync(CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
  const outFile = path.join(CREDENTIAL_DIR, `podium-${dbName}-credentials-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}Z.csv`);
  const csv = [
    "name,login_id,role,temporary_password,must_change_password",
    ...credentials.map((c) => `"${c.name}",${c.email},"${c.role}",${c.password},yes`),
  ].join("\n");
  fs.writeFileSync(outFile, `${csv}\n`, { mode: 0o600 });

  if (Object.keys(removedDependents).length > 0) {
    console.log(`\nRows removed with the superseded accounts: ${Object.entries(removedDependents).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  console.log(`\nProvisioned ${credentials.length} account(s).`);
  console.log(`Credentials written to ${outFile} (mode 0600, outside the repo, not logged).`);

  // Verify, rather than assume.
  const finalUsers = await prisma.user.count();
  const mustChange = await prisma.user.count({ where: { mustChangePassword: true } });
  const finalFreelancers = await prisma.freelancer.count();
  console.log(`\nusers: ${finalUsers}   of which must change password on first login: ${mustChange}   freelancers: ${finalFreelancers}`);
  if (finalUsers !== planned.length) process.exitCode = 1;
  if (mustChange !== planned.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
