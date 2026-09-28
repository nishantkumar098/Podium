import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { SLA_CLOCK_RUNS_OUTSIDE_BUSINESS_HOURS } from "../common/business-time";

/**
 * SLA breach → escalation (blueprint §6).
 *
 * WHAT CHANGED, AND WHY (BUG-005). This used to set `status = "ESCALATED"`.
 * `FlowStepStatus` is the step's position in the workflow, so writing
 * ESCALATED into it destroyed the only record of whether the work was READY or
 * already ACTIVE — and, far worse, made the step impossible to act on ever
 * again: `startStep` requires READY, `completeStep` requires READY or ACTIVE,
 * and an escalated step was neither. A mechanism whose entire job is to say
 * "this is late, please do it" was removing the work item from the workflow.
 *
 * Escalation is now a flag alongside the status — `escalatedAt` and
 * `escalationLevel` — and the status is left exactly as the humans left it.
 *
 * IDEMPOTENCE. The sweep runs every minute, and a breached step stays breached,
 * so the same step is selected on every tick until it is finished. What stops
 * that becoming a notification every sixty seconds is `escalationLevel`: a
 * level is acted on only when it is strictly higher than the level already
 * recorded, and the level is claimed with a guarded UPDATE that no second
 * sweep, worker or retry can win twice. Everything else — the notification,
 * the risk, the channel message, the audit row — happens only if that claim
 * succeeded.
 *
 * TIMEZONE. An SLA is a DURATION ("90 minutes from ready"), so it means the
 * same thing in every timezone and needs no conversion. What is a business
 * question is whether the clock should run overnight — see
 * SLA_CLOCK_RUNS_OUTSIDE_BUSINESS_HOURS in common/business-time.ts.
 */

/**
 * The escalation ladder.
 *
 * AMM-DECISION-SLA-LADDER — the multipliers and the recipients are mine, not
 * AMM's, and they are here rather than buried in a condition so they are easy
 * to see and to change. There is no reporting hierarchy in the schema, so
 * "the role above them" is approximated as: the person responsible, then the
 * project's PM, then whoever holds Founder or Admin.
 */
const ESCALATION_LADDER = [
  { level: 1, atSlaMultiple: 1, audience: "OWNER" as const, severity: "HIGH" as const },
  { level: 2, atSlaMultiple: 2, audience: "PM" as const, severity: "HIGH" as const },
  { level: 3, atSlaMultiple: 4, audience: "LEADERSHIP" as const, severity: "CRITICAL" as const },
];

/** Roles that stand in for "the level above the PM" until an org chart exists. */
const LEADERSHIP_ROLES = ["Founder", "Superadmin", "Admin"];

interface EscalationTarget {
  userIds: string[];
  /** How the recipients were arrived at, for the audit row. */
  resolution: string;
}

@Injectable()
export class FlowSlaService {
  private readonly logger = new Logger(FlowSlaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `now` is injectable so a test can place a step at any point on the ladder
   * without sleeping. The worker passes nothing.
   */
  async checkSlaBreaches(now: Date = new Date()): Promise<{ escalated: number; levels: Record<number, number> }> {
    const candidates = await this.prisma.client.flowStep.findMany({
      where: {
        // Only work a human could still act on. COMPLETED, CANCELLED, FAILED
        // and BLOCKED steps are not late — they are finished or stopped.
        status: { in: ["READY", "ACTIVE"] },
        readyAt: { not: null },
        deletedAt: null,
        // A step inside a cancelled flow, an archived flow, an archived
        // project or a cancelled project is not somebody's overdue work.
        // None of this was checked before: a project archived months ago went
        // on escalating its steps to its former PM every minute.
        flowInstance: {
          deletedAt: null,
          status: { notIn: ["CANCELLED", "COMPLETED"] },
          project: { deletedAt: null, status: { notIn: ["CANCELLED", "COMPLETED"] } },
        },
      },
      include: { flowInstance: { include: { project: true } } },
    });

    const levels: Record<number, number> = {};
    let escalated = 0;

    for (const step of candidates) {
      const due = this.dueLevel(step.readyAt!, step.slaMinutes, now);
      if (due === null || due.level <= step.escalationLevel) continue;

      try {
        const applied = await this.escalate(step.id, due.level, now);
        if (!applied) continue; // another sweep claimed this level first
        escalated++;
        levels[due.level] = (levels[due.level] ?? 0) + 1;
      } catch (err) {
        // One bad row must never stop the rest of the batch. The level is not
        // claimed on failure, so the next tick retries this step — which is
        // the retry behaviour, rather than a queue-level replay of the whole
        // sweep.
        this.logger.error(`Failed to escalate flow step ${step.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    if (escalated > 0) this.logger.warn(`Escalated ${escalated} SLA-breached flow step(s): ${JSON.stringify(levels)}`);
    return { escalated, levels };
  }

  /**
   * The highest ladder rung this step has passed, or null if it is still
   * inside its SLA.
   *
   * Deliberately `>=`-free: a step is late only once the deadline has PASSED,
   * so a step sitting exactly on its deadline is not yet breached. That
   * boundary is tested, because "at the deadline" is the case a person
   * disputes.
   */
  private dueLevel(readyAt: Date, slaMinutes: number, now: Date): { level: number } | null {
    let reached: { level: number } | null = null;
    for (const rung of ESCALATION_LADDER) {
      const deadline = readyAt.getTime() + slaMinutes * 60_000 * rung.atSlaMultiple;
      if (now.getTime() > deadline) reached = { level: rung.level };
    }
    return reached;
  }

  /**
   * Claim the level, then act. Returns false when another sweep got there
   * first — which is not an error, and must not produce a second notification.
   */
  private async escalate(stepId: string, level: number, now: Date): Promise<boolean> {
    const rung = ESCALATION_LADDER.find((r) => r.level === level)!;

    return this.prisma.client.$transaction(async (tx) => {
      /**
       * The idempotency claim, and the whole reason a repeated sweep is safe.
       *
       * `escalationLevel: { lt: level }` means exactly one caller can move a
       * step from level N to level N+1: a second sweep, a second worker, a
       * BullMQ redelivery or a retry after a crash all find the level already
       * raised and get count 0. Nothing below this line runs twice.
       */
      const claimed = await tx.flowStep.updateMany({
        where: { id: stepId, escalationLevel: { lt: level } },
        data: { escalationLevel: level, escalatedAt: now },
      });
      if (claimed.count === 0) return false;

      const step = await tx.flowStep.findUniqueOrThrow({
        where: { id: stepId },
        include: { flowInstance: { include: { project: true } }, owner: true },
      });
      const project = step.flowInstance.project;
      const flowName = step.flowInstance.name;

      const target = await this.resolveRecipients(tx, rung.audience, step.ownerId, project.pmId, project.workspaceId);

      // The risk is raised once and sharpened afterwards, rather than one risk
      // per level — three risks for one late step is noise, not signal.
      let riskId = step.escalationRiskId;
      if (riskId) {
        await tx.risk.updateMany({ where: { id: riskId, deletedAt: null }, data: { severity: rung.severity } });
      } else {
        const risk = await tx.risk.create({
          data: {
            projectId: project.id,
            title: `SLA breached: "${step.name}" in ${flowName}`,
            severity: rung.severity,
            ownerId: project.pmId,
            impact: "Flow handoff stalled past its target time — may delay downstream steps and the event timeline.",
            status: "OPEN",
          },
        });
        riskId = risk.id;
        await tx.flowStep.update({ where: { id: stepId }, data: { escalationRiskId: riskId } });
      }

      const overdueBy = Math.round((now.getTime() - (step.readyAt!.getTime() + step.slaMinutes * 60_000)) / 60_000);
      const text =
        `SLA breached (level ${level}): "${step.name}" in ${flowName} on ${project.name} ` +
        `is ${overdueBy} minute(s) past its ${step.slaMinutes}-minute target.`;

      for (const userId of target.userIds) {
        await tx.notification.create({
          data: { workspaceId: project.workspaceId, userId, icon: "⚠", text, sourceType: "flow_step", sourceId: stepId },
        });
      }

      const channel = await tx.channel.findFirst({ where: { projectId: project.id, kind: "PROJECT" } });
      if (channel) {
        await tx.message.create({
          data: {
            channelId: channel.id,
            authorId: null,
            body: `🤖 ⚠ ${text} Escalated to ${target.resolution}.`,
          },
        });
      }

      /**
       * A step is NOT moved to ESCALATED. It keeps the status its humans left
       * it in; the transition is recorded in the history instead, so the
       * escalation is still visible on the step's timeline without costing it
       * its place in the workflow.
       */
      await tx.flowStepRun.create({
        data: { stepId, fromStatus: step.status, toStatus: step.status, actorId: null },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          actorId: null,
          action: "flow_step.sla_escalated",
          entityType: "flow_step",
          entityId: stepId,
          after: {
            level,
            escalatedAt: now.toISOString(),
            statusUnchanged: step.status,
            overdueMinutes: overdueBy,
            recipients: target.userIds,
            recipientResolution: target.resolution,
            raisedRiskId: riskId,
            slaClockRunsOvernight: SLA_CLOCK_RUNS_OUTSIDE_BUSINESS_HOURS,
          },
        },
      });

      return true;
    });
  }

  /**
   * Who hears about it.
   *
   * Every rung falls through rather than failing: an inactive owner escalates
   * straight to the PM, an inactive PM straight to leadership, and a workspace
   * with nobody holding Founder or Admin produces an escalation with no
   * recipients — which is still recorded, with `resolution` saying so, because
   * an escalation nobody received must be visible rather than silently lost.
   */
  private async resolveRecipients(
    tx: TxClient,
    audience: "OWNER" | "PM" | "LEADERSHIP",
    ownerId: string,
    pmId: string,
    workspaceId: string,
  ): Promise<EscalationTarget> {
    if (audience === "OWNER") {
      const owner = await tx.user.findFirst({ where: { id: ownerId, isActive: true, deletedAt: null } });
      if (owner) return { userIds: [owner.id], resolution: "the step's owner" };
      // Somebody who has left the company cannot action their own step.
      return this.resolveRecipients(tx, "PM", ownerId, pmId, workspaceId);
    }

    if (audience === "PM") {
      const pm = await tx.user.findFirst({ where: { id: pmId, isActive: true, deletedAt: null } });
      if (pm) return { userIds: [pm.id], resolution: "the project's PM" };
      return this.resolveRecipients(tx, "LEADERSHIP", ownerId, pmId, workspaceId);
    }

    const leaders = await tx.user.findMany({
      where: {
        workspaceId,
        isActive: true,
        deletedAt: null,
        userRoles: { some: { role: { name: { in: LEADERSHIP_ROLES } } } },
      },
      select: { id: true },
    });
    if (leaders.length > 0) {
      return { userIds: leaders.map((l) => l.id), resolution: `leadership (${LEADERSHIP_ROLES.join("/")})` };
    }
    return { userIds: [], resolution: "NOBODY — no active Founder or Admin in this workspace" };
  }
}

/** The `tx` handle Prisma hands an interactive transaction callback. */
type TxClient = Parameters<Parameters<PrismaService["client"]["$transaction"]>[0]>[0];
