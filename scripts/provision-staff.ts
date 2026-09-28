/**
 * Podium v2 — create staff logins from "Employee Details.xlsx" (2026-09-18).
 *
 * Accounts are keyed on USERNAME — the person's name, lower-cased, spaces as
 * dots ("shweta.singh"). No e-mail is stored: the sheet's "official" e-mail
 * column holds shared department inboxes (one address for four people), and
 * personal addresses are not Podium's to keep.
 *
 * Every account is created WITHOUT a password. The first password the person
 * types at sign-in becomes permanent; after that only a Founder or Admin can
 * reset it (see AuthService).
 *
 * WHO. Office staff plus the two operational managers (Bar Manager, Catering
 * Manager): 18 people. The bar crew, helper, cleaner and guard are not given
 * logins — they are not Podium users, and an unclaimed account is one anyone
 * who knows the name could claim first.
 *
 * READS ONLY columns 0 NAME, 7 DESIGNATION, 8 DEPARTMENT, 13 OFFICE LOCATION.
 * The workbook also carries bank-account and government-ID columns (4, 5) and
 * a free-text KRA column that mentions salary; none of them is ever read. The
 * headers at the four indices used are checked first, so a re-ordered sheet
 * fails loudly instead of quietly reading the wrong column.
 *
 * Idempotent: re-running updates role/city/department in place and never
 * touches a password that has already been set.
 *
 * Usage:
 *   PODIUM_STAFF_FILE="C:/Users/dell/Downloads/Employee Details.xlsx" pnpm provision:staff --dry-run
 *   PODIUM_STAFF_FILE="C:/Users/dell/Downloads/Employee Details.xlsx" pnpm provision:staff
 */
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { normalizeUsername } from "../packages/shared-types/src/auth";
import { isForbiddenSheet, sensitiveColumnCategory } from "./forbidden-sheet";

const FILE = process.env.PODIUM_STAFF_FILE;
const DRY_RUN = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

const COLS = { name: 0, designation: 7, department: 8, location: 13 } as const;
const EXPECTED_HEADERS: Record<keyof typeof COLS, RegExp> = {
  name: /^NAME$/i,
  designation: /^DESIGNATION$/i,
  department: /^DEPARTMENT$/i,
  location: /^OFFICE LOCATION$/i,
};

/** Office address → city code. Checked in order; the first match wins. */
const LOCATION_CITY: Array<[RegExp, string]> = [
  [/dehradun/i, "DDN"],
  [/jaipur/i, "JPR"],
  [/mumbai/i, "BOM"],
  [/chennai/i, "MAA"],
  [/new delhi|delhi/i, "DEL"],
];

const DEHRADUN = { code: "DDN", name: "Dehradun", state: "Uttarakhand", gstStateCode: "05" };

type Role = "Founder" | "Superadmin" | "Admin" | "Finance" | "Operations" | "Project Manager" | "Sales" | "Creative" | "Employee";

/** Named people who hold more than their designation implies, by explicit instruction (2026-09-18). */
const EXTRA_ROLES: Record<string, Role[]> = {
  // First role is the primary one — the label shown. Nishant is shown as an
  // Employee but holds Superadmin access; Anant is Superadmin (21 Sep 2026,
  // scripts/staff-changes.ts and scripts/set-top-roles.ts).
  "nishant.kumar": ["Employee", "Superadmin"],
  anant: ["Superadmin"],
};

function rolesFor(name: string, designation: string, department: string): Role[] {
  return EXTRA_ROLES[normalizeUsername(name)] ?? [roleFor(name, designation, department)];
}

/**
 * Designation → Podium role. Founder is the superadmin. Explicit by name for
 * the admin seats, by designation/department for everyone else.
 */
function roleFor(name: string, designation: string, department: string): Role {
  if (/^anant$/i.test(name)) return "Founder";
  if (/head\s*hr/i.test(designation)) return "Admin";
  if (/finance/i.test(department)) return "Finance";
  if (/operations manager/i.test(designation)) return "Operations";
  if (/head|bar manager|catering manager/i.test(designation) || /^head/i.test(department)) return "Project Manager";
  if (/graphic|designer|web developer/i.test(designation)) return "Creative";
  if (/marketing/i.test(department)) return "Sales";
  return "Employee";
}

/** Office staff + the two operational managers; the bar crew gets no login. */
function getsLogin(designation: string, department: string): boolean {
  if (!/bar service/i.test(department)) return true;
  return /bar manager|catering manager/i.test(designation);
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const cell = (row: unknown[], i: number) => (row[i] == null ? "" : String(row[i]).replace(/\s+/g, " ").trim());

async function main() {
  if (!FILE) throw new Error("set PODIUM_STAFF_FILE to the Employee Details workbook");
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}\n${DRY_RUN ? "DRY RUN — " : ""}PROVISION STAFF LOGINS — ${dbName}\n${"=".repeat(72)}`);

  const sheets: string[] = XLSX.readFile(FILE, { bookSheets: true }).SheetNames;
  const sheet = sheets.find((s) => !isForbiddenSheet(s));
  if (!sheet || sheets.some(isForbiddenSheet)) throw new Error(`refusing: unexpected or sensitive sheets ${JSON.stringify(sheets)}`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(FILE, { sheets: [sheet] }).Sheets[sheet]!, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  const header = grid[0] ?? [];
  for (const [key, idx] of Object.entries(COLS) as Array<[keyof typeof COLS, number]>) {
    const h = cell(header, idx);
    if (!EXPECTED_HEADERS[key].test(h)) throw new Error(`column ${idx} should be ${key} but reads "${h}" — the sheet layout changed`);
    if (sensitiveColumnCategory(h)) throw new Error(`column ${idx} ("${h}") is classified sensitive — refusing`);
  }

  const workspace = await prisma.workspace.findFirstOrThrow();
  const roles = new Map((await prisma.role.findMany({ where: { workspaceId: workspace.id } })).map((r) => [r.name, r.id]));

  let cities = await prisma.city.findMany({ where: { workspaceId: workspace.id } });
  if (!cities.some((c) => c.code === DEHRADUN.code)) {
    console.log(`\ncity ${DEHRADUN.code} (${DEHRADUN.name}) does not exist — ${DRY_RUN ? "would create" : "creating"} it`);
    if (!DRY_RUN) {
      await prisma.city.create({ data: { workspaceId: workspace.id, ...DEHRADUN } });
      cities = await prisma.city.findMany({ where: { workspaceId: workspace.id } });
    }
  }
  const cityId = (code: string) => cities.find((c) => c.code === code)?.id ?? null;

  interface Person { name: string; username: string; roles: Role[]; dept: string; designation: string; cityCode: string }
  const people: Person[] = [];
  const skipped: string[] = [];
  // People removed from Podium — never recreated by a re-run (scripts/staff-changes.ts).
  const REMOVED = new Set(["tejashwani.bhatra"]);
  for (const row of grid.slice(1) as unknown[][]) {
    const raw = cell(row, COLS.name);
    if (!raw) continue;
    const name = titleCase(raw);
    const designation = cell(row, COLS.designation);
    const department = cell(row, COLS.department);
    if (!getsLogin(designation, department)) {
      skipped.push(`${name} (${designation || "no designation"})`);
      continue;
    }
    if (REMOVED.has(normalizeUsername(name))) {
      skipped.push(`${name} (removed from Podium)`);
      continue;
    }
    const location = cell(row, COLS.location);
    const cityCode = LOCATION_CITY.find(([re]) => re.test(location))?.[1];
    if (!cityCode) throw new Error(`no city for ${name}'s office "${location}"`);
    people.push({ name, username: normalizeUsername(name), roles: rolesFor(raw, designation, department), dept: department, designation, cityCode });
  }

  const dupes = people.map((p) => p.username).filter((u, i, a) => a.indexOf(u) !== i);
  if (dupes.length) throw new Error(`duplicate usernames: ${dupes.join(", ")} — disambiguate before provisioning`);

  console.log(`\n${people.length} login(s):`);
  for (const p of people) console.log(`   ${p.username.padEnd(20)} ${p.name.padEnd(20)} ${p.roles.join("+").padEnd(16)} ${p.cityCode}  ${p.designation}`);
  console.log(`\nno login (${skipped.length}): ${skipped.join(", ")}`);

  if (DRY_RUN) return console.log("\nDry run — nothing was written.");

  for (const p of people) {
    const roleIds = p.roles.map((r) => {
      const id = roles.get(r);
      if (!id) throw new Error(`role "${r}" does not exist in this workspace`);
      return id;
    });
    const roleId = roleIds[0]!;
    const primaryCityId = cityId(p.cityCode);
    const allCities = p.roles.some((r) => r === "Founder" || r === "Superadmin" || r === "Admin");

    await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { username: p.username } });
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { name: p.name, dept: p.dept, primaryRoleId: roleId, primaryCityId, isActive: true } })
        : await tx.user.create({
            data: {
              workspaceId: workspace.id,
              name: p.name,
              username: p.username,
              email: null,
              passwordHash: null, // set by the person at their first sign-in
              mustChangePassword: false,
              dept: p.dept,
              primaryRoleId: roleId,
              primaryCityId,
            },
          });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      for (const id of roleIds) await tx.userRole.create({ data: { userId: user.id, roleId: id } });
      await tx.userCityAccess.deleteMany({ where: { userId: user.id } });
      await tx.userCityAccess.create({
        data: allCities ? { userId: user.id, cityId: null, scope: "ALL" } : { userId: user.id, cityId: primaryCityId, scope: "WRITE" },
      });
    }, { maxWait: 20_000, timeout: 60_000 }); // Prisma's 5s default is too short over the Supabase pooler
  }

  console.log(`\nwritten. users with a username: ${await prisma.user.count({ where: { username: { not: null } } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
