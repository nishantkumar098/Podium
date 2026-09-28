import { PrismaClient } from "@prisma/client";
(async () => {
  const p = new PrismaClient();
  const roles = await p.role.findMany({ include: { rolePermissions: { include: { permission: true } }, _count: { select: { userRoles: true } } }, orderBy: { name: "asc" } });
  for (const r of roles) {
    const perms = r.rolePermissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`).sort();
    const byRes = new Map<string, string[]>();
    for (const x of perms) { const [res, act] = x.split(":"); byRes.set(res!, [...(byRes.get(res!) ?? []), act!]); }
    console.log(`\n${r.name}  (${r._count.userRoles} users, ${perms.length} permissions)`);
    console.log("   " + [...byRes.entries()].map(([res, acts]) => `${res}[${acts.join(",")}]`).join(" "));
  }
  const users = await p.user.findMany({ where: { deletedAt: null, isActive: true, isExternal: false }, select: { name: true, username: true, primaryRole: { select: { name: true } }, userRoles: { select: { role: { select: { name: true } } } }, cityAccess: { select: { scope: true, city: { select: { name: true } } } } }, orderBy: { name: "asc" } });
  console.log("\n--- people ---");
  for (const u of users) console.log(`${(u.username ?? "").padEnd(18)} ${u.name.padEnd(22)} primary=${u.primaryRole?.name ?? "—"} roles=${u.userRoles.map((x) => x.role.name).join("+") || "—"} cities=${u.cityAccess.map((c) => c.scope === "ALL" ? "ALL" : c.city?.name).join(",") || "—"}`);
  const allPerms = await p.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }] });
  const res = new Map<string, string[]>();
  for (const x of allPerms) res.set(x.resource, [...(res.get(x.resource) ?? []), x.action]);
  console.log("\n--- all permissions (" + allPerms.length + ") ---");
  console.log([...res.entries()].map(([r, a]) => `${r}[${a.join(",")}]`).join(" "));
  await p.$disconnect();
})();
