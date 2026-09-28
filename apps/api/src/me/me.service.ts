import { Injectable } from "@nestjs/common";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

const IST_OFFSET_MS = 330 * 60_000;
const DAY = 86_400_000;

function istMidnight(date: Date): Date {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

export interface CalendarItem {
  id: string;
  kind: "event" | "meeting" | "task" | "licence" | "invoice" | "leave";
  title: string;
  sub: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  href: string;
  late?: boolean;
}

/**
 * The person-centred screens: My Work (everything waiting on me) and the
 * Calendar (every dated record I can see). Both only read existing records.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async work(user: RequestUser) {
    const db = this.prisma.client;
    const can = (p: string) => user.permissions.has(p);
    const scope = this.cityScope.scopeFilter(user);
    const today = istMidnight(new Date());
    const weekAhead = new Date(today.getTime() + 8 * DAY);
    const inScope = { workspaceId: user.workspaceId, deletedAt: null, ...scope };

    const [tasks, steps, approvals, risks, cues, events, meetings] = await Promise.all([
      db.task.findMany({
        where: { ownerId: user.id, deletedAt: null, status: { not: "COMPLETED" }, project: inScope },
        select: { id: true, name: true, status: true, priority: true, dueAt: true, updatedAt: true, projectId: true, project: { select: { id: true, name: true } } },
        orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: 100,
      }),
      db.flowStep.findMany({
        where: { ownerId: user.id, deletedAt: null, status: { in: ["READY", "ACTIVE", "BLOCKED", "ESCALATED"] }, flowInstance: { status: "ACTIVE", deletedAt: null } },
        select: {
          id: true,
          name: true,
          status: true,
          readyAt: true,
          slaMinutes: true,
          flowInstance: { select: { id: true, name: true, project: { select: { id: true, name: true } } } },
        },
        orderBy: { readyAt: "asc" },
        take: 50,
      }),
      can("approvals:approve")
        ? db.approval.findMany({
            where: { status: "PENDING", deletedAt: null, requesterId: { not: user.id }, project: inScope },
            select: { id: true, title: true, type: true, approverRef: true, createdAt: true, project: { select: { id: true, name: true } } },
            orderBy: { createdAt: "asc" },
            take: 30,
          })
        : Promise.resolve([]),
      db.risk.findMany({
        where: { ownerId: user.id, deletedAt: null, status: { not: "CLOSED" }, project: inScope },
        select: { id: true, title: true, severity: true, status: true, project: { select: { id: true, name: true } } },
        take: 30,
      }),
      db.runsheetItem.findMany({
        where: { ownerId: user.id, doneAt: null, runsheet: { deletedAt: null, project: { ...inScope, eventDate: { gte: today, lt: weekAhead } } } },
        select: { id: true, text: true, scheduledTime: true, runsheet: { select: { project: { select: { id: true, name: true, eventDate: true } } } } },
        orderBy: [{ scheduledTime: "asc" }],
        take: 30,
      }),
      db.project.findMany({
        where: {
          ...inScope,
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          eventDate: { gte: today },
          OR: [{ pmId: user.id }, { members: { some: { userId: user.id, deletedAt: null } } }],
        },
        select: { id: true, name: true, type: true, eventDate: true, eventDateText: true, pmId: true, city: { select: { name: true } } },
        orderBy: { eventDate: "asc" },
        take: 8,
      }),
      can("tasks:view")
        ? db.meeting.findMany({
            where: {
              deletedAt: null,
              isSandbox: false,
              startsAt: { gte: today, lt: weekAhead },
              OR: [{ projectId: null }, { project: inScope }],
            },
            select: { id: true, title: true, startsAt: true, durationMinutes: true, meetLink: true, project: { select: { id: true, name: true } } },
            orderBy: { startsAt: "asc" },
            take: 20,
          })
        : Promise.resolve([]),
    ]);

    const now = Date.now();
    return {
      summary: {
        tasks: tasks.length,
        overdue: tasks.filter((t) => t.dueAt && t.dueAt.getTime() < today.getTime()).length,
        steps: steps.length,
        approvals: approvals.length,
        risks: risks.length,
      },
      tasks,
      steps: steps.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        flowId: s.flowInstance.id,
        flow: s.flowInstance.name,
        project: s.flowInstance.project,
        dueAt: s.readyAt ? new Date(s.readyAt.getTime() + s.slaMinutes * 60_000) : null,
        late: !!s.readyAt && s.readyAt.getTime() + s.slaMinutes * 60_000 < now,
      })),
      approvals,
      risks,
      cues: cues.map((c) => ({ id: c.id, text: c.text, time: c.scheduledTime, project: c.runsheet.project })),
      events: events.map((e) => ({ ...e, role: e.pmId === user.id ? "Project Manager" : "Crew" })),
      meetings,
    };
  }

  /** Every dated record the person can see between `from` and `to` (max ~3 months). */
  async calendar(user: RequestUser, fromRaw?: string, toRaw?: string, cityId?: string): Promise<CalendarItem[]> {
    const db = this.prisma.client;
    const can = (p: string) => user.permissions.has(p);
    const scope = this.cityScope.scopeFilter(user, cityId);
    const from = fromRaw ? new Date(fromRaw) : istMidnight(new Date());
    const toRequested = toRaw ? new Date(toRaw) : new Date(from.getTime() + 42 * DAY);
    const to = new Date(Math.min(toRequested.getTime(), from.getTime() + 100 * DAY));
    const range = { gte: from, lt: to };
    const inScope = { workspaceId: user.workspaceId, deletedAt: null, ...scope };
    const today = istMidnight(new Date());
    const none = Promise.resolve([] as CalendarItem[]);

    const groups = await Promise.all([
      can("projects:view")
        ? db.project
            .findMany({
              where: { ...inScope, eventDate: range, status: { not: "CANCELLED" } },
              select: { id: true, name: true, type: true, eventDate: true, eventDateText: true, city: { select: { name: true } } },
              take: 300,
            })
            .then((rows) =>
              rows.map<CalendarItem>((p) => ({
                id: `event:${p.id}`,
                kind: "event",
                title: p.name,
                sub: [p.type, p.city.name, p.eventDateText].filter(Boolean).join(" · "),
                start: p.eventDate,
                end: null,
                allDay: true,
                href: `/projects/${p.id}`,
              })),
            )
        : none,
      can("tasks:view")
        ? db.meeting
            .findMany({
              where: { deletedAt: null, isSandbox: false, startsAt: range, OR: [{ projectId: null }, { project: inScope }] },
              select: { id: true, title: true, startsAt: true, durationMinutes: true, project: { select: { name: true } } },
              take: 300,
            })
            .then((rows) =>
              rows.map<CalendarItem>((m) => ({
                id: `meeting:${m.id}`,
                kind: "meeting",
                title: m.title,
                sub: [m.project?.name, `${m.durationMinutes} min`].filter(Boolean).join(" · "),
                start: m.startsAt,
                end: new Date(m.startsAt.getTime() + m.durationMinutes * 60_000),
                allDay: false,
                href: `/meetings?id=${m.id}`,
              })),
            )
        : none,
      can("tasks:view")
        ? db.task
            .findMany({
              where: { deletedAt: null, status: { not: "COMPLETED" }, dueAt: range, project: inScope },
              select: { id: true, name: true, dueAt: true, ownerId: true, owner: { select: { name: true } }, project: { select: { id: true, name: true } } },
              orderBy: { dueAt: "asc" },
              take: 300,
            })
            .then((rows) =>
              rows.map<CalendarItem>((t) => ({
                id: `task:${t.id}`,
                kind: "task",
                title: t.name,
                sub: `${t.project.name} · ${t.ownerId === user.id ? "you" : t.owner.name}`,
                start: t.dueAt!,
                end: null,
                allDay: true,
                href: `/projects/${t.project.id}?tab=tasks`,
                late: t.dueAt!.getTime() < today.getTime(),
              })),
            )
        : none,
      can("licences:view")
        ? db.licence
            .findMany({
              where: { ...inScope, dueDate: range, status: { in: ["NOT_APPLIED", "APPLIED"] } },
              select: { id: true, type: true, authority: true, dueDate: true, city: { select: { name: true } } },
              take: 200,
            })
            .then((rows) =>
              rows.map<CalendarItem>((l) => ({
                id: `licence:${l.id}`,
                kind: "licence",
                title: l.type,
                sub: `${l.authority} · ${l.city.name}`,
                start: l.dueDate,
                end: null,
                allDay: true,
                href: `/compliance`,
                late: l.dueDate.getTime() < today.getTime(),
              })),
            )
        : none,
      can("invoices:view")
        ? db.invoice
            .findMany({
              where: { ...inScope, docType: "TAX_INVOICE", dueDate: range, status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] } },
              select: { id: true, invoiceNo: true, dueDate: true, total: true, client: { select: { name: true } } },
              take: 200,
            })
            .then((rows) =>
              rows.map<CalendarItem>((i) => ({
                id: `invoice:${i.id}`,
                kind: "invoice",
                title: `${i.invoiceNo} due`,
                sub: `${i.client.name} · ₹${i.total.toNumber().toLocaleString("en-IN")}`,
                start: i.dueDate,
                end: null,
                allDay: true,
                href: `/invoices/${i.id}`,
                late: i.dueDate.getTime() < today.getTime(),
              })),
            )
        : none,
      can("people:view")
        ? db.leave
            .findMany({
              where: { status: "APPROVED", fromDate: { lt: to }, toDate: { gte: from }, user: { workspaceId: user.workspaceId, deletedAt: null } },
              select: { id: true, type: true, fromDate: true, toDate: true, user: { select: { name: true } } },
              take: 200,
            })
            .then((rows) =>
              rows.map<CalendarItem>((l) => ({
                id: `leave:${l.id}`,
                kind: "leave",
                title: `${l.user.name} on leave`,
                sub: `${l.type.toLowerCase()} leave`,
                start: l.fromDate,
                end: l.toDate,
                allDay: true,
                href: `/people`,
              })),
            )
        : none,
    ]);
    return groups.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
  }
}
