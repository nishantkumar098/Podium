/**
 * Brings the database in line with the access model declared in
 * `apps/api/src/common/rbac/model.ts`.
 *
 * This is the only thing that writes roles, permissions or department
 * assignments. The model file says what the rules ARE; this script makes the
 * database agree with it, and prints every difference before touching
 * anything. Re-running it is safe and does nothing when there is nothing to
 * change.
 *
 *   dry run:  pnpm rbac:sync
 *   apply:    pnpm rbac:sync -- --apply
 *
 * What it does, in order:
 *   1. departments        one row per DEPARTMENTS entry
 *   2. permissions        one row per resource x action (plus the HR tiers)
 *   3. roles              one row per ROLES entry, description included
 *   4. role_permissions   set to EXACTLY the matrix — grants not in the
 *                         model are revoked, which is the point: a role that
 *                         quietly accumulated a permission loses it here
 *   5. people             department backfilled from their role, falling
 *                         back to the free-text User.dept
 *   6. named assignments  the three organisation-wide roles
 *   7. chat               a group per department, and one per city
 *
 * Step 4 is the destructive one. It is why the dry run prints every revoke.
 */
import { PrismaClient } from "@prisma/client";
import {
  ACTIONS,
  DEPARTMENTS,
  ROLES,
  allPermissions,
  departmentFromText,
  type DepartmentKey,
} from "../apps/api/src/common/rbac/model";

const APPLY = process.argv.includes("--apply");
const db = new PrismaClient();

/**
 * Roles renamed since they were created. Renaming in place keeps every user
 * and grant attached to the row; creating the new name instead would leave
 * an orphaned role with people still in it.
 */
const ROLE_RENAMES: Array<{ from: string; to: string }> = [{ from: "HR", to: "People & Resources" }];

/**
 * Who is who. This table is the whole staff directory as far as access is
 * concerned, and it REPLACES what each person holds rather than adding to
 * it: an assignment that only added would mean "Archi is People & Resources
 * AND still Admin", which is the opposite of what moving somebody means.
 *
 * `cities`:
 *   "ALL"    an explicit all-cities grant (never the absence of one)
 *   "KEEP"   leave their existing city access alone
 *   a name   exactly that city, and nothing else — this is what makes a
 *            City Head a City Head. The role says which KINDS of record
 *            they reach; this says whose.
 *
 * Someone listed here who has no account is created, with no password: the
 * first password they type at sign-in becomes theirs (see AuthService). No
 * password is ever written by this script, printed, or shared.
 */
interface Assignment {
  username: string;
  /** Used only when the account has to be created. */
  name: string;
  /** First entry is the primary role — the label the app shows for them. */
  roles: string[];
  department: DepartmentKey;
  cities: "ALL" | "KEEP" | string;
}

const ASSIGNMENTS: Assignment[] = [
  // --- full access, every city, every module
  { username: "architsinghal", name: "Archit Singhal", roles: ["Superadmin"], department: "LEADERSHIP", cities: "ALL" },
  { username: "nishant.kumar", name: "Nishant Kumar", roles: ["Superadmin"], department: "LEADERSHIP", cities: "ALL" },
  { username: "anant", name: "Anant", roles: ["Superadmin"], department: "LEADERSHIP", cities: "ALL" },

  // --- accounts and finance
  { username: "zumair.bin.zaheer", name: "Zumair Bin Zaheer", roles: ["Finance"], department: "FINANCE", cities: "ALL" },
  { username: "shweta.singh", name: "Shweta Singh", roles: ["Finance"], department: "FINANCE", cities: "ALL" },

  // --- people and resources
  { username: "kumkum", name: "Kumkum", roles: ["People & Resources"], department: "HR", cities: "ALL" },
  { username: "archi", name: "Archi", roles: ["People & Resources"], department: "HR", cities: "ALL" },

  // --- operations and task assignment
  { username: "yashwant.soyal", name: "Yashwant Soyal", roles: ["Operations"], department: "OPERATIONS", cities: "KEEP" },
  { username: "shobhit", name: "Shobhit", roles: ["Operations"], department: "OPERATIONS", cities: "ALL" },
  { username: "puran.rawat", name: "Puran Rawat", roles: ["Operations"], department: "OPERATIONS", cities: "KEEP" },
  { username: "manish", name: "Manish", roles: ["Operations"], department: "OPERATIONS", cities: "KEEP" },

  // --- city heads. Operations first so the app labels them by the work they
  // do; City Head is what widens them across their city's other modules.
  { username: "amit", name: "Amit", roles: ["Operations", "City Head"], department: "OPERATIONS", cities: "Dehradun" },
  { username: "harshitha.shetty", name: "Harshitha Shetty", roles: ["Operations", "City Head"], department: "OPERATIONS", cities: "Mumbai" },
  { username: "artem", name: "Artem", roles: ["City Head"], department: "OPERATIONS", cities: "Goa" },
  { username: "dennis", name: "Dennis", roles: ["City Head"], department: "OPERATIONS", cities: "Chennai" },
  { username: "davina", name: "Davina", roles: ["City Head"], department: "OPERATIONS", cities: "Chennai" },

  // --- marketing and sales
  { username: "aastha", name: "Aastha", roles: ["Sales", "Marketing"], department: "SALES", cities: "KEEP" },
  { username: "aryan.mishra", name: "Aryan Mishra", roles: ["Sales", "Marketing"], department: "SALES", cities: "KEEP" },
  { username: "riya", name: "Riya", roles: ["Marketing", "Sales"], department: "MARKETING", cities: "KEEP" },
  { username: "rohit", name: "Rohit", roles: ["Marketing", "Sales"], department: "MARKETING", cities: "KEEP" },
];

/**
 * People who have left AMM.
 *
 * Deactivated, never deleted. Their account stops working immediately — the
 * JWT strategy refuses an inactive or soft-deleted user on the very next
 * request, and the login path refuses them outright — but every row they
 * touched keeps pointing at a real person. Hard-deleting them would orphan
 * audit entries, the projects they ran, the tasks they owned and the
 * invoices they raised, and would quietly rewrite the company's own history
 * of who did what.
 *
 * Matched on username first, then on exact name, because some older
 * accounts predate usernames.
 */
const LEAVERS: Array<{ username?: string; name?: string; note: string }> = [
  { username: "vishal", name: "Vishal", note: "left the company" },
  { name: "Tejaswini Bhatra", note: "left the company" },
];

/** Which department a role implies, for people whose `dept` text says nothing useful. */
const DEPT_OF_ROLE = new Map<string, DepartmentKey>(
  ROLES.filter((r) => r.department).map((r) => [r.name, r.department as DepartmentKey]),
);

const changes: string[] = [];
const note = (line: string) => {
  changes.push(line);
  console.log(`  ${line}`);
};

async function main() {
  const workspace = await db.workspace.findFirst({ where: { deletedAt: null }, select: { id: true, name: true } });
  if (!workspace) throw new Error("No workspace found.");
  console.log(`\nWorkspace: ${workspace.name}`);
  console.log(APPLY ? "Mode: APPLY — the database will be changed.\n" : "Mode: DRY RUN — nothing will be written. Re-run with --apply.\n");

  // ---------------------------------------------------------- departments
  console.log("Departments");
  const deptId = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const existing = await db.department.findFirst({ where: { workspaceId: workspace.id, key: d.key } });
    if (existing) {
      deptId.set(d.key, existing.id);
      if (existing.name !== d.name || existing.deletedAt) {
        note(`update ${d.key} -> ${d.name}`);
        if (APPLY) await db.department.update({ where: { id: existing.id }, data: { name: d.name, deletedAt: null } });
      }
      continue;
    }
    note(`create ${d.key} (${d.name})`);
    if (APPLY) {
      const row = await db.department.create({ data: { workspaceId: workspace.id, key: d.key, name: d.name } });
      deptId.set(d.key, row.id);
    }
  }

  // ---------------------------------------------------------- permissions
  console.log("\nPermissions");
  const wanted = allPermissions();
  const existingPerms = await db.permission.findMany({ where: { workspaceId: workspace.id } });
  const permId = new Map(existingPerms.map((p) => [`${p.resource}:${p.action}`, p.id]));
  for (const key of wanted) {
    if (permId.has(key)) continue;
    const [resource, action] = key.split(":");
    note(`create permission ${key}`);
    if (APPLY) {
      const row = await db.permission.create({ data: { workspaceId: workspace.id, resource: resource!, action: action! } });
      permId.set(key, row.id);
    }
  }
  // Permissions no longer in the model are left in place on purpose: dropping
  // a permission row would cascade into role_permissions and audit history
  // for no benefit. They simply stop being granted below.
  const orphaned = [...permId.keys()].filter((k) => !wanted.includes(k));
  if (orphaned.length) console.log(`  (${orphaned.length} permission(s) no longer in the model, left in place: ${orphaned.join(", ")})`);

  // ----------------------------------------------------------------- roles
  console.log("\nRoles and grants");
  for (const r of ROLE_RENAMES) {
    const old = await db.role.findFirst({ where: { workspaceId: workspace.id, name: r.from } });
    if (!old) continue;
    const clash = await db.role.findFirst({ where: { workspaceId: workspace.id, name: r.to } });
    if (clash) continue; // already renamed on an earlier run
    note(`rename role ${r.from} -> ${r.to}`);
    if (APPLY) await db.role.update({ where: { id: old.id }, data: { name: r.to } });
  }
  for (const spec of ROLES) {
    let role = await db.role.findFirst({ where: { workspaceId: workspace.id, name: spec.name } });
    if (!role) {
      note(`create role ${spec.name}`);
      if (APPLY) role = await db.role.create({ data: { workspaceId: workspace.id, name: spec.name, description: spec.description } });
    } else if (role.description !== spec.description || role.deletedAt) {
      note(`update role ${spec.name} (description)`);
      if (APPLY) role = await db.role.update({ where: { id: role.id }, data: { description: spec.description, deletedAt: null } });
    }
    if (!role) continue; // dry run, role does not exist yet

    const held = await db.rolePermission.findMany({ where: { roleId: role.id }, include: { permission: true } });
    const heldKeys = new Set(held.map((h) => `${h.permission.resource}:${h.permission.action}`));
    const wantKeys = new Set(spec.permissions);

    const toGrant = [...wantKeys].filter((k) => !heldKeys.has(k));
    const toRevoke = [...heldKeys].filter((k) => !wantKeys.has(k));
    if (toGrant.length) note(`${spec.name}: grant ${toGrant.length} — ${toGrant.join(", ")}`);
    if (toRevoke.length) note(`${spec.name}: REVOKE ${toRevoke.length} — ${toRevoke.join(", ")}`);
    if (!APPLY) continue;
    for (const k of toGrant) {
      const id = permId.get(k);
      if (!id) throw new Error(`Permission ${k} is granted by ${spec.name} but does not exist.`);
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: id } });
    }
    for (const k of toRevoke) {
      const id = permId.get(k);
      if (id) await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: id } });
    }
  }

  // --------------------------------------------------------------- people
  console.log("\nPeople -> department");
  const people = await db.user.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, isExternal: false },
    select: { id: true, name: true, username: true, dept: true, departmentId: true, primaryRole: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  for (const p of people) {
    if (p.departmentId) continue;
    // The role is the better signal: it is what authorization already uses,
    // and AMM's free-text dept column is inconsistent. Text is the fallback.
    const key = (p.primaryRole ? DEPT_OF_ROLE.get(p.primaryRole.name) : null) ?? departmentFromText(p.dept);
    if (!key) {
      console.log(`  (${p.name}: no department could be determined — left unassigned)`);
      continue;
    }
    const id = deptId.get(key);
    note(`${p.name} -> ${key}`);
    if (APPLY && id) await db.user.update({ where: { id: p.id }, data: { departmentId: id } });
  }

  // --------------------------------------------------------------- leavers
  console.log("\nPeople who have left");
  for (const l of LEAVERS) {
    const rows = await db.user.findMany({
      where: {
        workspaceId: workspace.id,
        OR: [...(l.username ? [{ username: l.username }] : []), ...(l.name ? [{ name: l.name }] : [])],
      },
      select: { id: true, name: true, username: true, isActive: true, deletedAt: true },
    });
    if (rows.length === 0) {
      console.log(`  (no account for ${l.username ?? l.name} — nothing to do)`);
      continue;
    }
    for (const u of rows) {
      if (!u.isActive && u.deletedAt) continue; // already gone
      note(`DEACTIVATE ${u.name} (${u.username ?? "no username"}) — ${l.note}`);
      if (!APPLY) continue;
      await db.$transaction([
        db.user.update({ where: { id: u.id }, data: { isActive: false, deletedAt: new Date() } }),
        // Every open session ends now rather than at token expiry.
        db.refreshToken.deleteMany({ where: { userId: u.id } }),
        // Access grants go with them; the account keeps its history.
        db.userRole.deleteMany({ where: { userId: u.id } }),
        db.userCityAccess.deleteMany({ where: { userId: u.id } }),
        db.auditLog.create({
          data: {
            workspaceId: workspace.id,
            actorId: null,
            action: "user.deactivated",
            entityType: "user",
            entityId: u.id,
            after: { name: u.name, username: u.username, reason: l.note },
          },
        }),
      ]);
    }
  }

  // ------------------------------------------------- people -> role, city
  console.log("\nRole and city assignments");
  const cityByName = new Map(
    (await db.city.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } })).map((c) => [c.name, c.id]),
  );

  const leaverNames = new Set(LEAVERS.flatMap((l) => [l.username, l.name].filter((x): x is string => !!x)));
  for (const a of ASSIGNMENTS) {
    if (leaverNames.has(a.username) || leaverNames.has(a.name)) {
      console.log(`  (!) ${a.name} is in both ASSIGNMENTS and LEAVERS — remove one; skipped`);
      continue;
    }
    const roleIds: string[] = [];
    for (const name of a.roles) {
      const role = await db.role.findFirst({ where: { workspaceId: workspace.id, name } });
      if (!role) {
        console.log(`  (role "${name}" does not exist yet — run with --apply)`);
        break;
      }
      roleIds.push(role.id);
    }
    if (roleIds.length !== a.roles.length) continue;

    let user = await db.user.findFirst({
      where: { workspaceId: workspace.id, username: a.username },
      include: { userRoles: { include: { role: true } }, cityAccess: true },
    });

    const cityId = a.cities === "ALL" || a.cities === "KEEP" ? null : cityByName.get(a.cities) ?? null;
    if (a.cities !== "ALL" && a.cities !== "KEEP" && !cityId) {
      console.log(`  (!) ${a.name}: city "${a.cities}" does not exist — skipped`);
      continue;
    }

    // --- create the account if there isn't one. No password is set: the
    // first one they type at sign-in becomes theirs, which is how every
    // other account in this workspace was created.
    if (!user) {
      note(`CREATE ${a.name} (${a.username}) — ${a.roles.join("+")}, ${a.cities}`);
      if (!APPLY) continue;
      const created = await db.user.create({
        data: {
          workspaceId: workspace.id,
          name: a.name,
          username: a.username,
          dept: DEPARTMENTS.find((d) => d.key === a.department)?.name ?? null,
          departmentId: deptId.get(a.department) ?? null,
          primaryRoleId: roleIds[0],
          primaryCityId: cityId,
          isActive: true,
        },
      });
      user = await db.user.findFirstOrThrow({ where: { id: created.id }, include: { userRoles: { include: { role: true } }, cityAccess: true } });
    } else if (user.deletedAt) {
      note(`${a.name}: reactivating a soft-deleted account`);
      if (APPLY) await db.user.update({ where: { id: user.id }, data: { deletedAt: null, isActive: true } });
    }

    // --- roles
    const have = user.userRoles.map((ur) => ur.role.name).sort();
    const want = [...a.roles].sort();
    const rolesDiffer = have.join("|") !== want.join("|") || user.primaryRoleId !== roleIds[0];
    if (rolesDiffer) {
      note(`${a.name}: ${have.join("+") || "no role"} -> ${a.roles.join("+")}`);
      if (APPLY) {
        await db.userRole.deleteMany({ where: { userId: user.id } });
        for (const roleId of roleIds) await db.userRole.create({ data: { userId: user.id, roleId } });
      }
    }
    if (user.departmentId !== (deptId.get(a.department) ?? null)) {
      note(`${a.name}: department -> ${a.department}`);
    }
    if (APPLY) {
      await db.user.update({
        where: { id: user.id },
        data: {
          primaryRoleId: roleIds[0],
          departmentId: deptId.get(a.department) ?? null,
          ...(cityId ? { primaryCityId: cityId } : {}),
        },
      });
    }

    // --- city access. "All cities" is an explicit ALL row, and a city head
    // holds exactly one city row: anything else left behind would quietly
    // widen them, which is the whole thing city scoping exists to prevent.
    if (a.cities === "KEEP") continue;
    const currentCities = user.cityAccess.map((c) => (c.scope === "ALL" ? "ALL" : cityByName.get(a.cities) === c.cityId ? a.cities : `other:${c.cityId}`));
    const wantCities = [a.cities === "ALL" ? "ALL" : a.cities];
    if (currentCities.sort().join("|") !== wantCities.join("|")) {
      note(`${a.name}: cities ${currentCities.join(",") || "none"} -> ${wantCities.join(",")}`);
      if (APPLY) {
        await db.userCityAccess.deleteMany({ where: { userId: user.id } });
        await db.userCityAccess.create({
          data: a.cities === "ALL" ? { userId: user.id, cityId: null, scope: "ALL" } : { userId: user.id, cityId: cityId!, scope: "WRITE" },
        });
      }
    }
  }

  // --- anyone NOT in the table keeps what they have. Say so, rather than
  // leaving it to be discovered.
  const unlisted = await db.user.findMany({
    where: {
      workspaceId: workspace.id,
      deletedAt: null,
      isActive: true,
      isExternal: false,
      username: { notIn: [...ASSIGNMENTS.map((a) => a.username), ...LEAVERS.map((l) => l.username).filter((u): u is string => !!u)] },
    },
    select: { name: true, username: true, primaryRole: { select: { name: true } } },
  });
  for (const u of unlisted) {
    console.log(`  (not in the access list, left unchanged: ${u.name} / ${u.username} — ${u.primaryRole?.name ?? "no role"})`);
  }

  // ----------------------------------------------------------------- chat
  console.log("\nChat groups");
  for (const d of DEPARTMENTS) {
    const id = deptId.get(d.key);
    if (!id) continue;
    const name = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const existing = await db.channel.findFirst({ where: { workspaceId: workspace.id, kind: "DEPARTMENT", departmentId: id, deletedAt: null } });
    if (existing) continue;
    note(`create department group #${name}`);
    if (APPLY) {
      await db.channel.create({
        data: { workspaceId: workspace.id, name, kind: "DEPARTMENT", departmentId: id, description: `${d.name} team` },
      });
    }
  }
  const cities = await db.city.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } });
  for (const c of cities) {
    const existing = await db.channel.findFirst({ where: { workspaceId: workspace.id, kind: "CITY", cityId: c.id, deletedAt: null } });
    if (existing) continue;
    const name = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    note(`create city group #${name}`);
    if (APPLY) {
      await db.channel.create({ data: { workspaceId: workspace.id, name, kind: "CITY", cityId: c.id, description: `${c.name} team` } });
    }
  }

  // --------------------------------------------------------------- report
  console.log(`\n${changes.length} change(s) ${APPLY ? "applied" : "pending"}.`);
  if (!APPLY && changes.length) console.log("Re-run with --apply to write them.\n");
  if (APPLY) {
    console.log("Signed-in users pick up new permissions within a minute (the JWT strategy caches identities for 60s).\n");
  }
  // Sanity checks that outlive any hand-editing of the matrix.
  const superadmin = ROLES.find((r) => r.name === "Superadmin")!;
  if (!superadmin.permissions.includes("people:view_identity")) throw new Error("Superadmin must hold every permission.");
  const cityHead = ROLES.find((r) => r.name === "City Head")!;
  const money = cityHead.permissions.filter((p) => /^(invoices|payments|budgets|expenses):/.test(p));
  if (money.length) throw new Error(`City Head must hold no company-finance permission, but the model grants: ${money.join(", ")}`);
  void ACTIONS;
}

main()
  .catch((e) => {
    console.error("\nsync-rbac failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
