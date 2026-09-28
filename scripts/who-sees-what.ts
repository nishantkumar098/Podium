/**
 * Prints every account, what it can reach, and which screens it will see.
 *
 *   pnpm who:sees
 *
 * The screen list is PARSED OUT OF AppShell.tsx rather than copied here, so
 * this cannot drift from the real navigation: add an item to the sidebar and
 * it appears in this report on the next run, with whatever permission it
 * actually carries. Read-only — it never writes to the database.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORG_WIDE_ROLES } from "../apps/api/src/common/rbac/model";

const db = new PrismaClient();

interface Screen {
  href: string;
  label: string;
  perm?: string;
  roles?: string[];
}

/** The sidebar, read from the component that draws it. */
function screens(): Screen[] {
  const src = readFileSync(resolve(__dirname, "../apps/web/components/AppShell.tsx"), "utf8");
  const block = src.slice(src.indexOf("const NAV_GROUPS"), src.indexOf("type Creating"));
  const out: Screen[] = [];
  for (const line of block.split("\n")) {
    const href = /href:\s*"([^"]+)"/.exec(line);
    if (!href) continue;
    const label = /label:\s*"([^"]+)"/.exec(line);
    const perm = /perm:\s*"([^"]+)"/.exec(line);
    const roles = /roles:\s*ORG_WIDE_ROLES/.test(line);
    out.push({
      href: href[1]!,
      label: label?.[1] ?? href[1]!.replace("/", ""),
      ...(perm ? { perm: perm[1]! } : {}),
      ...(roles ? { roles: [...ORG_WIDE_ROLES] } : {}),
    });
  }
  return out;
}

async function main() {
  const nav = screens();
  const users = await db.user.findMany({
    where: { deletedAt: null, isExternal: false },
    include: {
      department: { select: { name: true } },
      primaryRole: { select: { name: true } },
      userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } },
      cityAccess: { include: { city: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });

  console.log(`\n${users.length} accounts. "Screens" is exactly what their sidebar will offer.\n`);

  for (const u of users) {
    const perms = new Set<string>();
    for (const ur of u.userRoles) for (const rp of ur.role.rolePermissions) perms.add(`${rp.permission.resource}:${rp.permission.action}`);
    const roleNames = u.userRoles.map((r) => r.role.name);

    const visible = nav.filter((s) => (s.roles ? s.roles.some((r) => roleNames.includes(r)) : !s.perm || perms.has(s.perm)));
    const cities = u.cityAccess.some((c) => c.scope === "ALL")
      ? "every city"
      : u.cityAccess.map((c) => c.city?.name).filter(Boolean).join(", ") || "none";

    const state = !u.isActive ? "  [INACTIVE]" : u.passwordHash ? "" : "  [no password yet — set at first sign-in]";
    console.log(`${u.username ?? "(no username)"}${state}`);
    console.log(`   ${u.name} · ${roleNames.join(" + ") || "no role"} · ${u.department?.name ?? "no department"} · ${cities}`);
    console.log(`   ${perms.size} permissions, ${visible.length}/${nav.length} screens`);
    console.log(`   sees:   ${visible.map((s) => s.label).join(", ")}`);
    const hidden = nav.filter((s) => !visible.includes(s));
    console.log(`   hidden: ${hidden.map((s) => s.label).join(", ") || "nothing"}`);
    console.log();
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
