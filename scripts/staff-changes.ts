/**
 * Podium — staff account changes (21 Sep 2026).
 *
 *  1. Remove Tejashwani Bhatra from Podium.
 *     Her account is closed, not erased: deletedAt + isActive=false, every
 *     session revoked, so she can't sign in and drops out of every picker,
 *     directory and list (they all filter on deletedAt/isActive). Records
 *     she was merely attached to are detached — leads she owned become
 *     unowned, her project-crew places and chat memberships are removed.
 *     Records that REQUIRE an owner (tasks, risks, flow steps, run-of-show
 *     cues) are listed and the run stops, so nothing is silently re-owned.
 *     The audit trail keeps her name on what she did — that history is
 *     never rewritten.
 *
 *  2. Nishant Kumar: shown as Employee, with Superadmin access.
 *     Roles become [Employee (primary), Superadmin]. The primary role is the
 *     label the app shows; permissions are the union of both roles, so he
 *     keeps every Superadmin power. Founder and Admin are removed.
 *
 * Usage:  pnpm staff:changes            # dry run
 *         pnpm staff:changes --apply
 */
import { prisma } from "@podium/db";

const APPLY = process.argv.includes("--apply");
const REMOVE_USERNAME = "tejashwani.bhatra";
const NISHANT_USERNAME = "nishant.kumar";

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } });
  const roles = new Map((await prisma.role.findMany({ where: { workspaceId: workspace.id } })).map((r) => [r.name, r.id]));
  for (const r of ["Employee", "Superadmin"]) if (!roles.has(r)) throw new Error(`Role "${r}" missing — run pnpm roles:top first.`);

  // ------------------------------------------------------------ Tejashwani
  const teja = await prisma.user.findFirst({ where: { username: REMOVE_USERNAME } });
  if (!teja) throw new Error(`No user "${REMOVE_USERNAME}".`);
  const [leads, members, channels, tasks, risks, steps, cues, pmOf, attendance, leaves, notifications, sessions] = await Promise.all([
    prisma.lead.count({ where: { ownerId: teja.id } }),
    prisma.projectMember.count({ where: { userId: teja.id, deletedAt: null } }),
    prisma.channelMember.count({ where: { userId: teja.id } }),
    prisma.task.count({ where: { ownerId: teja.id, deletedAt: null, status: { not: "COMPLETED" } } }),
    prisma.risk.count({ where: { ownerId: teja.id, deletedAt: null, status: { not: "CLOSED" } } }),
    prisma.flowStep.count({ where: { ownerId: teja.id, deletedAt: null, status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    prisma.runsheetItem.count({ where: { ownerId: teja.id, doneAt: null } }),
    prisma.project.count({ where: { pmId: teja.id, deletedAt: null } }),
    prisma.attendance.count({ where: { userId: teja.id } }),
    prisma.leave.count({ where: { userId: teja.id } }),
    prisma.notification.count({ where: { userId: teja.id } }),
    prisma.refreshToken.count({ where: { userId: teja.id, revokedAt: null } }),
  ]);
  console.log(`${teja.name} (${teja.username}) — ${teja.deletedAt ? "ALREADY REMOVED" : teja.isActive ? "active" : "inactive"}`);
  console.log({ leadsOwned: leads, projectCrewPlaces: members, chatMemberships: channels, openSessions: sessions, attendanceRows: attendance, leaveRows: leaves, notifications });
  const blocking = { openTasks: tasks, openRisks: risks, openFlowSteps: steps, openRunsheetCues: cues, projectsAsPM: pmOf };
  console.log("must be re-owned first:", blocking);
  const blocked = Object.values(blocking).some((n) => n > 0);

  // --------------------------------------------------------------- Nishant
  const nishant = await prisma.user.findFirst({ where: { username: NISHANT_USERNAME, deletedAt: null }, include: { userRoles: { include: { role: true } }, primaryRole: true } });
  if (!nishant) throw new Error(`No user "${NISHANT_USERNAME}".`);
  console.log(`\n${nishant.name}: ${nishant.userRoles.map((r) => r.role.name).join(", ")} (primary ${nishant.primaryRole?.name ?? "—"}) -> Employee (primary) + Superadmin`);

  if (!APPLY) return console.log("\nDry run — nothing was written. Re-run with --apply.");
  if (blocked) throw new Error("Tejashwani still owns open work (see above) — reassign it, then re-run.");

  await prisma.$transaction(
    async (tx) => {
      if (!teja.deletedAt) {
        await tx.lead.updateMany({ where: { ownerId: teja.id }, data: { ownerId: null } });
        await tx.projectMember.updateMany({ where: { userId: teja.id, deletedAt: null }, data: { deletedAt: new Date() } });
        await tx.channelMember.deleteMany({ where: { userId: teja.id } });
        await tx.refreshToken.updateMany({ where: { userId: teja.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.user.update({ where: { id: teja.id }, data: { isActive: false, deletedAt: new Date(), passwordHash: null } });
        await tx.auditLog.create({
          data: {
            workspaceId: workspace.id, actorId: null, action: "user.removed", entityType: "user", entityId: teja.id,
            after: { name: teja.name, username: teja.username, leadsUnassigned: leads, via: "scripts/staff-changes.ts" },
          },
        });
      }

      const employee = roles.get("Employee")!;
      const superadmin = roles.get("Superadmin")!;
      await tx.userRole.deleteMany({ where: { userId: nishant.id } });
      await tx.userRole.createMany({ data: [{ userId: nishant.id, roleId: employee }, { userId: nishant.id, roleId: superadmin }] });
      await tx.user.update({ where: { id: nishant.id }, data: { primaryRoleId: employee } });
      // Superadmin works across every city.
      await tx.userCityAccess.deleteMany({ where: { userId: nishant.id } });
      await tx.userCityAccess.create({ data: { userId: nishant.id, cityId: null, scope: "ALL" } });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id, actorId: null, action: "roles.changed", entityType: "user", entityId: nishant.id,
          after: { name: nishant.name, roles: ["Employee (primary)", "Superadmin"], via: "scripts/staff-changes.ts" },
        },
      });
    },
    { maxWait: 20_000, timeout: 60_000 },
  );

  const after = await prisma.user.findMany({
    where: { username: { in: [REMOVE_USERNAME, NISHANT_USERNAME] } },
    select: { username: true, isActive: true, deletedAt: true, primaryRole: { select: { name: true } }, userRoles: { select: { role: { select: { name: true } } } } },
  });
  console.log("\nDone:");
  for (const u of after)
    console.log(`   ${u.username!.padEnd(18)} ${u.deletedAt ? "REMOVED" : "active"}  roles ${u.userRoles.map((r) => r.role.name).join(", ") || "—"}  shown as ${u.primaryRole?.name ?? "—"}`);
  console.log("The API caches signed-in users for 60 s — changes apply within a minute.");
}

main()
  .catch((e) => {
    console.error(String(e).split("\n").slice(0, 3).join("\n"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
