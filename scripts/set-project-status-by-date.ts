/**
 * Podium — set project status from the event date.
 *
 * The imported projects all arrived as PLANNING, whatever their event date,
 * so a wedding from last September sat in the same bucket as one in December.
 * AMM's rule: an event whose date has passed the cutoff is finished; an event
 * on or after it is still to come.
 *
 *   event date <  cutoff  ->  COMPLETED
 *   event date >= cutoff  ->  PLANNING   (only if it was wrongly COMPLETED)
 *
 * Deliberately narrow, so it can be re-run safely:
 *   - CANCELLED projects are never touched — cancelled is not "finished".
 *   - A future project already in a working state (IN_PROGRESS, CLIENT_REVIEW,
 *     ON_HOLD, PLANNED) keeps it; only a wrong COMPLETED is reverted.
 *
 * Usage:
 *   pnpm projects:status              # dry run, prints what would change
 *   pnpm projects:status --apply      # writes
 *   pnpm projects:status --cutoff 2026-09-01 --apply
 */
import { prisma } from "@podium/db";

const APPLY = process.argv.includes("--apply");
const cutoffArg = process.argv[process.argv.indexOf("--cutoff") + 1];
const CUTOFF = new Date(`${/^\d{4}-\d{2}-\d{2}$/.test(cutoffArg ?? "") ? cutoffArg : "2026-09-01"}T00:00:00+05:30`);

const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  // The cutoff is IST midnight; print the IST calendar day, not the UTC one.
  const day = new Date(CUTOFF.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  console.log(`${workspace.name} — cutoff ${day} (events before it are completed)\n`);

  const toComplete = await prisma.project.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, eventDate: { lt: CUTOFF }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, name: true, eventDate: true, status: true },
    orderBy: { eventDate: "asc" },
  });
  const toReopen = await prisma.project.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, eventDate: { gte: CUTOFF }, status: "COMPLETED" },
    select: { id: true, name: true, eventDate: true, status: true },
    orderBy: { eventDate: "asc" },
  });

  console.log(`To mark COMPLETED (event before ${day}): ${toComplete.length}`);
  for (const p of toComplete.slice(0, 5)) console.log(`   ${istDay(p.eventDate)}  ${p.name}`);
  if (toComplete.length > 5) console.log(`   … and ${toComplete.length - 5} more`);
  console.log(`\nTo return to PLANNING (event on/after ${day}): ${toReopen.length}`);
  for (const p of toReopen) console.log(`   ${istDay(p.eventDate)}  ${p.name}`);

  if (!APPLY) {
    console.log("\nDry run — nothing was written. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }

  // Two set-based updates rather than one per project: the database is far
  // away and 300 round trips would take minutes.
  const completed = await prisma.project.updateMany({
    where: { workspaceId: workspace.id, deletedAt: null, eventDate: { lt: CUTOFF }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED" },
  });
  const reopened = await prisma.project.updateMany({
    where: { workspaceId: workspace.id, deletedAt: null, eventDate: { gte: CUTOFF }, status: "COMPLETED" },
    data: { status: "PLANNING" },
  });
  await prisma.auditLog.create({
    data: {
      workspaceId: workspace.id,
      actorId: null,
      action: "project.status_backfilled",
      entityType: "workspace",
      entityId: workspace.id,
      after: { cutoff: day, completed: completed.count, reopened: reopened.count, via: "scripts/set-project-status-by-date.ts" },
    },
  });

  console.log(`\nMarked completed: ${completed.count}`);
  console.log(`Returned to planning: ${reopened.count}`);
  const remaining = await prisma.project.groupBy({ by: ["status"], where: { workspaceId: workspace.id, deletedAt: null }, _count: { _all: true } });
  console.log("Now:", remaining.map((r) => `${r.status}:${r._count._all}`).join(" "));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(String(e).split("\n").slice(0, 3).join("\n"));
  await prisma.$disconnect();
  process.exit(1);
});
