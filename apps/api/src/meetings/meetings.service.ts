import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { GoogleService } from "../google/google.service";

export interface MeetingInput {
  title: string;
  startsAt: Date;
  durationMinutes: number;
  projectId?: string | null;
  meetLink?: string | null;
  notes?: string | null;
  /** Ask Google Calendar for a real Meet link (needs a connected Google account). */
  createMeetLink?: boolean;
}

const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(\?.*)?$/i;

/**
 * Meetings · Meet. A meeting belongs to the workspace through its project,
 * or stands alone (company meetings). Action items can be promoted into real
 * project tasks.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly google: GoogleService,
  ) {}

  /** Meetings the caller may see: stand-alone ones, and those on projects in their cities. */
  private visible(user: RequestUser) {
    const scope = this.cityScope.scopeFilter(user);
    return {
      deletedAt: null,
      isSandbox: false,
      OR: [{ projectId: null }, { project: { workspaceId: user.workspaceId, deletedAt: null, ...scope } }],
    };
  }

  async list(user: RequestUser, opts: { from?: Date; to?: Date; projectId?: string }) {
    const db = this.prisma.client;
    const rows = await db.meeting.findMany({
      where: {
        ...this.visible(user),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.from || opts.to ? { startsAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        actionItems: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { startsAt: "asc" },
      take: 300,
    });
    const ownerIds = [...new Set(rows.flatMap((m) => m.actionItems.map((a) => a.ownerId)))];
    const owners = ownerIds.length ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(owners.map((o) => [o.id, o.name]));
    return rows.map((m) => ({
      ...m,
      actionItems: m.actionItems.map((a) => ({ ...a, ownerName: nameOf.get(a.ownerId) ?? "—" })),
    }));
  }

  async create(user: RequestUser, input: MeetingInput) {
    const project = input.projectId ? await this.loadProject(user, input.projectId) : null;
    let meetLink = this.cleanLink(input.meetLink);
    if (input.createMeetLink) {
      meetLink = await this.google.createMeetEvent(user, {
        title: project ? `${input.title} — ${project.name}` : input.title,
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes,
        description: input.notes ?? undefined,
      });
    }
    const meeting = await this.prisma.client.meeting.create({
      data: {
        title: input.title.trim(),
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes,
        projectId: project?.id ?? null,
        meetLink,
        notes: input.notes?.trim() || null,
      },
    });
    await this.audit(user, "meeting.scheduled", meeting.id, { title: meeting.title, projectId: meeting.projectId, startsAt: meeting.startsAt });
    return meeting;
  }

  async update(user: RequestUser, id: string, input: Partial<MeetingInput>) {
    const meeting = await this.load(user, id);
    if (input.projectId) await this.loadProject(user, input.projectId);
    const updated = await this.prisma.client.meeting.update({
      where: { id: meeting.id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId || null } : {}),
        ...(input.meetLink !== undefined ? { meetLink: this.cleanLink(input.meetLink) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      },
    });
    await this.audit(user, "meeting.updated", meeting.id, { title: updated.title, projectId: updated.projectId });
    return updated;
  }

  async remove(user: RequestUser, id: string) {
    const meeting = await this.load(user, id);
    await this.prisma.client.meeting.update({ where: { id: meeting.id }, data: { deletedAt: new Date() } });
    await this.audit(user, "meeting.cancelled", meeting.id, { title: meeting.title, projectId: meeting.projectId });
    return { ok: true };
  }

  async addActionItem(user: RequestUser, meetingId: string, text: string, ownerId: string) {
    const meeting = await this.load(user, meetingId);
    const owner = await this.prisma.client.user.findFirst({ where: { id: ownerId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!owner) throw new BadRequestException("That person is not a user in this workspace.");
    const item = await this.prisma.client.meetingActionItem.create({ data: { meetingId: meeting.id, text: text.trim(), ownerId } });
    await this.audit(user, "meeting.action_item_added", item.id, { text: item.text, projectId: meeting.projectId });
    return item;
  }

  /**
   * Turns an action item into a real task on the meeting's project (or the
   * project chosen, for a stand-alone meeting). Idempotent: an item already
   * promoted returns its task.
   */
  async promote(user: RequestUser, itemId: string, input: { projectId?: string; dueAt?: Date }) {
    const db = this.prisma.client;
    const item = await db.meetingActionItem.findFirst({ where: { id: itemId }, include: { meeting: true } });
    if (!item) throw new NotFoundException("Action item not found.");
    await this.load(user, item.meetingId);
    if (item.promotedTaskId) {
      const existing = await db.task.findUnique({ where: { id: item.promotedTaskId } });
      if (existing) return existing;
    }
    const projectId = item.meeting.projectId ?? input.projectId;
    if (!projectId) throw new BadRequestException("This meeting has no project — choose the project the task belongs to.");
    await this.loadProject(user, projectId);
    const task = await db.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          projectId,
          name: item.text.slice(0, 240),
          ownerId: item.ownerId,
          dueAt: input.dueAt ?? null,
          status: "PLANNED",
          priority: "MEDIUM",
          createdById: user.id,
          updatedById: user.id,
        },
      });
      await tx.meetingActionItem.update({ where: { id: item.id }, data: { promotedTaskId: created.id } });
      return created;
    });
    await this.audit(user, "task.create", task.id, { name: task.name, projectId, from: "meeting" });
    return task;
  }

  // ---------------------------------------------------------------- helpers

  private cleanLink(link: string | null | undefined): string | null {
    const v = link?.trim();
    if (!v) return null;
    if (!MEET_LINK.test(v)) throw new BadRequestException("Paste a Google Meet link (https://meet.google.com/…).");
    return v;
  }

  private async load(user: RequestUser, id: string) {
    const meeting = await this.prisma.client.meeting.findFirst({ where: { id, ...this.visible(user) } });
    if (!meeting) throw new NotFoundException("Meeting not found.");
    return meeting;
  }

  private async loadProject(user: RequestUser, projectId: string) {
    const project = await this.prisma.client.project.findFirst({ where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return project;
  }

  private async audit(user: RequestUser, action: string, entityId: string, after: Record<string, unknown>) {
    await this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action, entityType: "meeting", entityId, after: after as object },
    });
  }
}
