import type { PrismaClient } from "@podium/db";

/**
 * Recomputes a project's `health` from overdue tasks, open critical risks,
 * days-to-event and budget overrun (blueprint §19) — never client-set.
 * Thresholds are a documented starting assumption (see docs/STATUS.md); tune
 * once Ops has real signal on what should flip a project amber/red.
 *
 * Called after anything that feeds the score changes (task or risk created or
 * updated), so the dot on Projects/Home reflects the project as it is now.
 */
export async function recomputeProjectHealth(db: PrismaClient, projectId: string): Promise<"GREEN" | "AMBER" | "RED"> {
  const [overdueTasks, openCriticalRisks, project] = await Promise.all([
    db.task.count({ where: { projectId, status: { not: "COMPLETED" }, dueAt: { lt: new Date() }, deletedAt: null } }),
    db.risk.count({ where: { projectId, severity: "CRITICAL", status: { in: ["OPEN", "MITIGATING"] }, deletedAt: null } }),
    db.project.findUniqueOrThrow({ where: { id: projectId }, select: { eventDate: true, estCost: true, actCost: true, health: true } }),
  ]);
  const daysToEvent = Math.ceil((project.eventDate.getTime() - Date.now()) / 86_400_000);
  const budgetVarianceRatio = project.estCost.toNumber() > 0 ? project.actCost.toNumber() / project.estCost.toNumber() : 0;

  let health: "GREEN" | "AMBER" | "RED" = "GREEN";
  if (openCriticalRisks > 0 || (daysToEvent >= 0 && daysToEvent <= 3 && overdueTasks > 0) || budgetVarianceRatio > 1.15) {
    health = "RED";
  } else if (overdueTasks > 0 || budgetVarianceRatio > 1.0) {
    health = "AMBER";
  }
  if (health !== project.health) await db.project.update({ where: { id: projectId }, data: { health } });
  return health;
}
