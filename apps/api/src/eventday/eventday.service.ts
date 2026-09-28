import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  CreateIncidentInput,
  CreateRunsheetInput,
  AddRunsheetItemInput,
  CheckInInput,
} from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { recomputeProjectHealth } from "../common/project-health";
import type { RequestUser } from "../common/types";

/** Incidents at or above this severity auto-raise a risk (blueprint §20). */
const AUTO_ESCALATES = new Set(["HIGH", "CRITICAL"]);

/**
 * Event Day (blueprint §20): the run-of-show checklist, crew check-in, and the
 * incident log.
 *
 * The one behaviour that must not be merely stored is escalation: a HIGH or
 * CRITICAL incident raises a real `risks` row, notifies the project's PM, and
 * posts into the project channel — all in the same transaction as the incident
 * itself, so an incident can never exist without the escalation it triggered.
 */
@Injectable()
export class EventDayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  // -------------------------------------------------------------- runsheet

  async getRunsheet(user: RequestUser, projectId: string) {
    const project = await this.loadProject(user, projectId);
    const runsheet = await this.prisma.client.runsheet.findFirst({
      where: { projectId: project.id, deletedAt: null },
      include: { items: { orderBy: [{ sortOrder: "asc" }, { scheduledTime: "asc" }] } },
    });
    return runsheet ?? { projectId: project.id, items: [] };
  }

  async createRunsheet(user: RequestUser, projectId: string, input: CreateRunsheetInput) {
    const project = await this.loadProject(user, projectId);
    const existing = await this.prisma.client.runsheet.findFirst({ where: { projectId: project.id, deletedAt: null } });
    if (existing) throw new BadRequestException("This project already has a runsheet — add items to it instead.");

    const owners = await this.assertUsersExist(user, input.items.map((i) => i.ownerId));
    return this.prisma.client.$transaction(async (tx) => {
      const runsheet = await tx.runsheet.create({
        data: {
          projectId: project.id,
          items: {
            create: input.items.map((item, i) => ({
              scheduledTime: item.scheduledTime,
              text: item.text,
              ownerId: item.ownerId,
              sortOrder: item.sortOrder ?? i,
            })),
          },
        },
        include: { items: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "runsheet.create",
          entityType: "runsheet", entityId: runsheet.id,
          after: { projectId: project.id, items: runsheet.items.length, owners: owners.length },
        },
      });
      return runsheet;
    });
  }

  async addRunsheetItem(user: RequestUser, runsheetId: string, input: AddRunsheetItemInput) {
    const runsheet = await this.loadRunsheet(user, runsheetId);
    await this.assertUsersExist(user, [input.ownerId]);
    const count = await this.prisma.client.runsheetItem.count({ where: { runsheetId: runsheet.id } });
    return this.prisma.client.runsheetItem.create({
      data: {
        runsheetId: runsheet.id,
        scheduledTime: input.scheduledTime,
        text: input.text,
        ownerId: input.ownerId,
        sortOrder: input.sortOrder ?? count,
      },
    });
  }

  /**
   * Ticks (or un-ticks) a cue. Only the cue's owner, the project's PM, or
   * someone holding projects:edit may do it — on event day the checklist is
   * the operational record, so who ticked what is an accountability question,
   * not a convenience.
   */
  async setRunsheetItemDone(user: RequestUser, itemId: string, done: boolean) {
    const item = await this.prisma.client.runsheetItem.findFirst({
      where: { id: itemId },
      include: { runsheet: { include: { project: true } } },
    });
    if (!item) throw new NotFoundException("Runsheet item not found.");
    const project = item.runsheet.project;
    if (project.workspaceId !== user.workspaceId) throw new NotFoundException("Runsheet item not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);

    const mayTick = item.ownerId === user.id || project.pmId === user.id || user.permissions.has("projects:edit");
    if (!mayTick) {
      throw new ForbiddenException("Only this cue's owner, the project PM, or a manager can tick it off.");
    }

    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.runsheetItem.update({
        where: { id: item.id },
        data: { doneAt: done ? new Date() : null },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id,
          action: done ? "runsheet_item.done" : "runsheet_item.undone",
          entityType: "runsheet_item", entityId: item.id,
          before: { doneAt: item.doneAt }, after: { doneAt: updated.doneAt },
        },
      });
      return updated;
    });
  }

  // -------------------------------------------------------------- check-in

  async listCheckins(user: RequestUser, projectId: string) {
    const project = await this.loadProject(user, projectId);
    const checkins = await this.prisma.client.eventDayCheckin.findMany({
      where: { projectId: project.id },
      orderBy: { checkedInAt: "asc" },
    });
    // BUG-011 (2026-09-12, found building Phase D frontend): userId has no
    // Prisma relation to User (event_day_checkins predates it needing one),
    // so a checker-in outside the project's own roster — e.g. a Founder
    // checking themselves in on a project they aren't a member of, which
    // checkIn() explicitly allows — had no name to display. Same fix
    // pattern as assertUsersExist() below: a single batched lookup.
    const names = await this.namesFor(checkins.map((c) => c.userId));
    return checkins.map((c) => ({ ...c, userName: names.get(c.userId) ?? "Unknown" }));
  }

  /**
   * Checks a real employee in. Anyone with projects:edit can check a colleague
   * in (a PM signing in crew at the gate is the normal case); everyone else may
   * only check themselves in.
   */
  async checkIn(user: RequestUser, projectId: string, input: CheckInInput) {
    const project = await this.loadProject(user, projectId);
    const targetId = input.userId ?? user.id;
    if (targetId !== user.id && !user.permissions.has("projects:edit")) {
      throw new ForbiddenException("You can only check yourself in.");
    }
    await this.assertUsersExist(user, [targetId]);

    const already = await this.prisma.client.eventDayCheckin.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: targetId } },
    });
    if (already) return already; // idempotent: checking in twice is not an error

    return this.prisma.client.$transaction(async (tx) => {
      const checkin = await tx.eventDayCheckin.create({ data: { projectId: project.id, userId: targetId } });
      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "event_day.checkin",
          entityType: "event_day_checkin", entityId: checkin.id,
          after: { projectId: project.id, userId: targetId },
        },
      });
      return checkin;
    });
  }

  // ------------------------------------------------------------- incidents

  async listIncidents(user: RequestUser, projectId: string) {
    const project = await this.loadProject(user, projectId);
    const incidents = await this.prisma.client.eventDayIncident.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
    });
    // BUG-011: see listCheckins() above — reportedById has the same gap.
    const names = await this.namesFor(incidents.map((i) => i.reportedById));
    return incidents.map((i) => ({ ...i, reportedByName: names.get(i.reportedById) ?? "Unknown" }));
  }

  /**
   * Logs an incident and, for HIGH/CRITICAL, escalates it for real: a `risks`
   * row owned by the project's PM, a notification, and a Podium Bot message in
   * the project channel. All in one transaction — an incident recorded without
   * the escalation it was supposed to trigger is the failure mode this guards
   * against.
   */
  async createIncident(user: RequestUser, projectId: string, input: CreateIncidentInput) {
    const project = await this.loadProject(user, projectId);
    const escalates = AUTO_ESCALATES.has(input.severity);

    const result = await this.prisma.client.$transaction(async (tx) => {
      const incident = await tx.eventDayIncident.create({
        data: { projectId: project.id, severity: input.severity, text: input.text, reportedById: user.id },
      });

      let risk: { id: string } | null = null;
      if (escalates) {
        risk = await tx.risk.create({
          data: {
            projectId: project.id,
            title: `Event-day incident: ${input.text.slice(0, 120)}`,
            severity: input.severity === "CRITICAL" ? "CRITICAL" : "HIGH",
            // The PM owns it: they are the accountable person on the day, and
            // the schema has no org hierarchy to find a "manager" from.
            ownerId: project.pmId,
            impact: `Raised automatically from a ${input.severity} incident reported by ${user.name}.`,
            status: "OPEN",
            sourceIncidentId: incident.id,
          },
        });
        await tx.eventDayIncident.update({ where: { id: incident.id }, data: { raisedRiskId: risk.id } });

        await tx.notification.create({
          data: {
            workspaceId: user.workspaceId,
            userId: project.pmId,
            icon: "⚠",
            text: `${input.severity} incident on ${project.name}: ${input.text.slice(0, 120)}`,
            sourceType: "event_day_incident",
            sourceId: incident.id,
          },
        });

        const channel = await tx.channel.findFirst({ where: { projectId: project.id, deletedAt: null } });
        if (channel) {
          await tx.message.create({
            data: {
              channelId: channel.id,
              authorId: null, // Podium Bot
              body: `⚠ ${input.severity} incident logged by ${user.name}: ${input.text} — risk raised and assigned to the PM.`,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId, actorId: user.id, action: "event_day.incident_logged",
          entityType: "event_day_incident", entityId: incident.id,
          after: { projectId: project.id, severity: input.severity, escalated: escalates, riskId: risk?.id ?? null },
        },
      });

      return { ...incident, raisedRiskId: risk?.id ?? null, escalated: escalates };
    });
    // An escalated incident is a new open risk, which feeds project health.
    if (escalates) await recomputeProjectHealth(this.prisma.client, project.id);
    return result;
  }

  // --------------------------------------------------------------- helpers

  private async loadProject(user: RequestUser, projectId: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return project;
  }

  private async loadRunsheet(user: RequestUser, runsheetId: string) {
    const runsheet = await this.prisma.client.runsheet.findFirst({
      where: { id: runsheetId, deletedAt: null },
      include: { project: true },
    });
    if (!runsheet || runsheet.project.workspaceId !== user.workspaceId) throw new NotFoundException("Runsheet not found.");
    this.cityScope.assertCanAccessCity(user, runsheet.project.cityId);
    return runsheet;
  }

  /** Batched id->name lookup for BUG-011 (see listCheckins/listIncidents above). */
  private async namesFor(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async assertUsersExist(user: RequestUser, ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.client.user.findMany({
      where: { id: { in: unique }, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new BadRequestException("One or more of those people are not users in this workspace.");
    }
    return found;
  }
}
