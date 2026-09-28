/**
 * Podium — the two top roles: Founder and Superadmin.
 *
 * Superadmin carries exactly the Founder's permissions and powers (every
 * name-based check in the code treats the two alike — password resets, the
 * audit log, settings, escalations). The only difference is the label:
 * Founder is for the company's founders, Superadmin for whoever runs the
 * system for them.
 *
 * This run:
 *   - creates the Superadmin role if missing, with every permission Founder has
 *   - anant          -> Superadmin (no longer Founder)
 *   - architsinghal  -> Founder (account created if it doesn't exist; the
 *                       password is set by Archit at first sign-in)
 *
 * Usage:  pnpm roles:top            # dry run
 *         pnpm roles:top --apply
 */
import { prisma } from "@podium/db";

const APPLY = process.argv.includes("--apply");

const SUPERADMIN_USERNAME = "anant";
const FOUNDER = { username: "architsinghal", name: "Archit Singhal", dept: "Management" };

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  const founderRole = await prisma.role.findFirstOrThrow({
    where: { workspaceId: workspace.id, name: "Founder" },
    include: { rolePermissions: true },
  });
  const existingSuper = await prisma.role.findFirst({ where: { workspaceId: workspace.id, name: "Superadmin" }, include: { rolePermissions: true } });
  const anant = await prisma.user.findFirst({ where: { username: SUPERADMIN_USERNAME, deletedAt: null }, include: { userRoles: { include: { role: true } } } });
  const archit = await prisma.user.findFirst({ where: { username: FOUNDER.username, deletedAt: null }, include: { userRoles: { include: { role: true } } } });
  const lookalikes = await prisma.user.findMany({
    where: { deletedAt: null, OR: [{ name: { contains: "archi", mode: "insensitive" } }, { username: { contains: "archi", mode: "insensitive" } }] },
    select: { username: true, name: true, userRoles: { select: { role: { select: { name: true } } } } },
  });
  const hq = await prisma.city.findFirst({ where: { workspaceId: workspace.id, isHq: true, deletedAt: null }, select: { id: true, name: true } });

  console.log(workspace.name);
  console.log(`Founder role: ${founderRole.rolePermissions.length} permissions`);
  console.log(`Superadmin role: ${existingSuper ? `exists (${existingSuper.rolePermissions.length} permissions)` : "will be created"}`);
  if (!anant) throw new Error(`No user "${SUPERADMIN_USERNAME}".`);
  console.log(`\n${anant.username} (${anant.name}): ${anant.userRoles.map((r) => r.role.name).join(", ")} -> Superadmin`);
  console.log(
    `${FOUNDER.username}: ${archit ? `exists (${archit.name}; ${archit.userRoles.map((r) => r.role.name).join(", ")}) -> Founder` : `will be created as "${FOUNDER.name}", Founder, all cities${hq ? `, base ${hq.name}` : ""}`}`,
  );
  console.log("\nExisting accounts that look like 'archi' (check this isn't the same person):");
  for (const u of lookalikes) console.log(`   ${u.username}  "${u.name}"  ${u.userRoles.map((r) => r.role.name).join(", ")}`);

  if (!APPLY) {
    console.log("\nDry run — nothing was written. Re-run with --apply.");
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      // 1. Superadmin role = Founder's permissions, kept in step on every run.
      const superRole =
        existingSuper ??
        (await tx.role.create({
          data: { workspaceId: workspace.id, name: "Superadmin", description: "Runs Podium for the founders — same access and powers as Founder" },
        }));
      await tx.rolePermission.deleteMany({ where: { roleId: superRole.id } });
      await tx.rolePermission.createMany({ data: founderRole.rolePermissions.map((rp) => ({ roleId: superRole.id, permissionId: rp.permissionId })) });

      // 2. Anant: Superadmin instead of Founder. City access stays "all cities".
      await tx.userRole.deleteMany({ where: { userId: anant.id } });
      await tx.userRole.create({ data: { userId: anant.id, roleId: superRole.id } });
      await tx.user.update({ where: { id: anant.id }, data: { primaryRoleId: superRole.id } });
      await tx.userCityAccess.deleteMany({ where: { userId: anant.id } });
      await tx.userCityAccess.create({ data: { userId: anant.id, cityId: null, scope: "ALL" } });

      // 3. Archit: Founder, all cities. No password — he sets it at first sign-in.
      const user =
        archit ??
        (await tx.user.create({
          data: {
            workspaceId: workspace.id,
            name: FOUNDER.name,
            username: FOUNDER.username,
            email: null,
            passwordHash: null,
            mustChangePassword: false,
            dept: FOUNDER.dept,
            primaryRoleId: founderRole.id,
            primaryCityId: hq?.id ?? null,
          },
        }));
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      await tx.userRole.create({ data: { userId: user.id, roleId: founderRole.id } });
      await tx.user.update({ where: { id: user.id }, data: { primaryRoleId: founderRole.id, isActive: true } });
      await tx.userCityAccess.deleteMany({ where: { userId: user.id } });
      await tx.userCityAccess.create({ data: { userId: user.id, cityId: null, scope: "ALL" } });

      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: null,
          action: "roles.top_roles_set",
          entityType: "workspace",
          entityId: workspace.id,
          after: { superadmin: SUPERADMIN_USERNAME, founderAdded: FOUNDER.username, founderCreated: !archit, via: "scripts/set-top-roles.ts" },
        },
      });
    },
    { maxWait: 20_000, timeout: 60_000 },
  );

  const after = await prisma.user.findMany({
    where: { username: { in: [SUPERADMIN_USERNAME, FOUNDER.username] } },
    select: { username: true, name: true, passwordHash: true, userRoles: { select: { role: { select: { name: true } } } } },
  });
  console.log("\nDone:");
  for (const u of after) console.log(`   ${u.username.padEnd(15)} ${u.name.padEnd(16)} ${u.userRoles.map((r) => r.role.name).join(", ")}  password ${u.passwordHash ? "set" : "not set yet (first sign-in)"}`);
  console.log("Note: the API caches signed-in users for 60 s — changes apply within a minute.");
}

main()
  .catch((e) => {
    console.error(String(e).split("\n").slice(0, 3).join("\n"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
