import { ForbiddenException, Injectable } from "@nestjs/common";
import { businessDateParts } from "../common/business-time";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { totalUnread } from "../chat/unread";
import { GoogleService } from "../google/google.service";
import { allowedCityIds, type RequestUser } from "../common/types";
import { ORG_WIDE_ROLES } from "../common/rbac/model";

/** Who may post an announcement: the organisation-wide roles, plus Operations. */
const MANAGER_ROLES = [...ORG_WIDE_ROLES, "Operations"];
const ANNOUNCEMENTS = "announcements";
const IST_OFFSET_MS = 330 * 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: { toNumber(): number } | null | undefined) => d?.toNumber() ?? 0;

/** Midnight (IST) of the day `date` falls on, as a UTC instant. */
function istMidnight(date: Date): Date {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

/**
 * Home (control tower). Everything the screen shows comes back in ONE
 * response, computed from live records.
 *
 * Built for a distant database: every query is independent and fired at
 * once, and nested `include`s (each a further sequential round trip) are
 * avoided in favour of aggregates and small lookups joined here.
 *
 * Each widget is only computed for someone who could open the screen behind
 * it (receivables need invoices:view, pipeline leads:view, and so on);
 * otherwise it is `null` and the page leaves it out.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly google: GoogleService,
  ) {}

  async home(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    const ws = user.workspaceId;
    const can = (p: string) => user.permissions.has(p);
    const scope = this.cityScope.scopeFilter(user, cityId);
    const allowed = allowedCityIds(user);
    const now = new Date();
    const today = istMidnight(now);
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const { year, month } = businessDateParts(now);
    const monthStart = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
    const live = { workspaceId: ws, deletedAt: null, status: { notIn: ["COMPLETED", "CANCELLED"] as ("COMPLETED" | "CANCELLED")[] }, ...scope };
    const upcoming = { ...live, eventDate: { gte: today } };
    const openInvoice = {
      workspaceId: ws,
      deletedAt: null,
      docType: "TAX_INVOICE" as const,
      status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] as ("ISSUED" | "PARTIALLY_PAID" | "OVERDUE")[] },
      ...scope,
    };
    const cityIdFilter = allowed === "ALL" ? null : allowed;
    const skip = <T,>(v: T) => Promise.resolve(v);

    const [
      health,
      projects,
      upcomingTasks,
      people,
      cities,
      collected,
      invoiceTotals,
      invoicePayments,
      invoiceCredits,
      invoiceDebits,
      overdueByCity,
      pipeline,
      monthRevenue,
      monthExpenses,
      lowStock,
      queue,
      waiting,
      flows,
      approvals,
      risks,
      meetings,
      announcements,
      activity,
    ] = await Promise.all([
      // Booked revenue is money: summed only for a caller who may see it,
      // so the figure is absent rather than merely unrendered for everyone
      // else. The counts beside it are operational and stay.
      db.project.groupBy({ by: ["health"], where: live, _count: { _all: true }, ...(can("budgets:view") ? { _sum: { revenue: true } } : {}) }),
      can("projects:view")
        ? db.project.findMany({
            where: upcoming,
            orderBy: { eventDate: "asc" },
            take: 8,
            select: { id: true, name: true, type: true, eventDate: true, eventDateText: true, status: true, health: true, cityId: true, pmId: true },
          })
        : skip([] as Array<{ id: string; name: string; type: string; eventDate: Date; eventDateText: string | null; status: string; health: string; cityId: string; pmId: string }>),
      db.task.groupBy({ by: ["projectId", "status"], where: { deletedAt: null, project: upcoming }, _count: { _all: true } }),
      db.user.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } }),
      db.city.findMany({
        where: { workspaceId: ws, deletedAt: null, ...(cityIdFilter ? { id: { in: cityIdFilter } } : {}) },
        orderBy: [{ isHq: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isHq: true },
      }),
      can("invoices:view") ? db.payment.aggregate({ where: { invoice: { workspaceId: ws, deletedAt: null, ...scope } }, _sum: { amount: true } }) : skip(null),
      can("invoices:view") ? db.invoice.aggregate({ where: openInvoice, _sum: { total: true }, _count: { _all: true } }) : skip(null),
      can("invoices:view") ? db.payment.aggregate({ where: { invoice: openInvoice }, _sum: { amount: true } }) : skip(null),
      can("invoices:view") ? db.creditNote.aggregate({ where: { invoice: openInvoice }, _sum: { amount: true } }) : skip(null),
      can("invoices:view") ? db.debitNote.aggregate({ where: { invoice: openInvoice }, _sum: { amount: true } }) : skip(null),
      can("invoices:view")
        ? db.invoice.groupBy({ by: ["cityId"], where: { ...openInvoice, status: "OVERDUE" }, _count: { _all: true } })
        : skip([] as Array<{ cityId: string; _count: { _all: number } }>),
      can("leads:view")
        ? db.lead.aggregate({
            where: { workspaceId: ws, deletedAt: null, kind: "PIPELINE", stage: { notIn: ["WON", "LOST"] }, ...scope },
            _sum: { value: true },
            _count: { _all: true },
          })
        : skip(null),
      can("invoices:view")
        ? db.invoice.groupBy({
            by: ["cityId"],
            where: { workspaceId: ws, deletedAt: null, docType: "TAX_INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: monthStart } },
            _sum: { taxableAmount: true },
          })
        : skip([] as Array<{ cityId: string; _sum: { taxableAmount: { toNumber(): number } | null } }>),
      can("invoices:view")
        ? db.$queryRaw<Array<{ city_id: string; amount: number }>>`
            SELECT p.city_id, sum(e.amount)::float8 AS amount
            FROM expenses e JOIN projects p ON p.id = e.project_id
            WHERE p.workspace_id = ${ws}::uuid AND e.deleted_at IS NULL
              AND e.status::text IN ('APPROVED', 'REIMBURSED') AND e.incurred_at >= ${monthStart}
            GROUP BY p.city_id`
        : skip([] as Array<{ city_id: string; amount: number }>),
      can("inventory:view")
        ? db.$queryRaw<Array<{ city_id: string; n: number }>>`
            SELECT l.city_id, count(*)::int AS n
            FROM inventory_balances b
            JOIN inventory_locations l ON l.id = b.location_id
            JOIN inventory_items i ON i.id = b.sku_id
            WHERE i.workspace_id = ${ws}::uuid AND i.deleted_at IS NULL AND b.reorder_level > 0 AND b.qty_on_hand <= b.reorder_level
            GROUP BY l.city_id`
        : skip([] as Array<{ city_id: string; n: number }>),
      db.flowStep.findMany({
        where: {
          ownerId: user.id,
          status: { in: ["READY", "ACTIVE", "BLOCKED", "ESCALATED"] },
          deletedAt: null,
          flowInstance: { status: "ACTIVE", deletedAt: null },
        },
        select: { id: true, name: true, status: true, readyAt: true, slaMinutes: true, flowInstance: { select: { id: true, name: true } } },
        orderBy: { readyAt: "asc" },
        take: 6,
      }),
      db.flowStep.findMany({
        where: { ownerId: user.id, status: "LOCKED", deletedAt: null, flowInstance: { status: "ACTIVE", deletedAt: null } },
        select: {
          id: true,
          name: true,
          flowInstance: { select: { name: true } },
          dependsOn: { select: { dependsOnStep: { select: { status: true, ownerId: true } } } },
        },
        take: 4,
      }),
      can("flows:view")
        ? db.flowInstance.findMany({
            where: { status: "ACTIVE", deletedAt: null, project: { workspaceId: ws, ...scope } },
            select: { id: true, name: true, steps: { where: { deletedAt: null }, select: { status: true } } },
            orderBy: { updatedAt: "desc" },
            take: 4,
          })
        : skip(null),
      can("approvals:view")
        ? db.approval.findMany({
            where: { status: "PENDING", deletedAt: null, project: { workspaceId: ws, ...scope } },
            select: { id: true, title: true, type: true, project: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
            take: 4,
          })
        : skip(null),
      can("risks:view")
        ? db.risk.findMany({
            where: { status: { not: "CLOSED" }, deletedAt: null, project: { workspaceId: ws, ...scope } },
            select: { id: true, title: true, severity: true, ownerId: true, project: { select: { id: true, name: true } } },
          })
        : skip(null),
      db.meeting.findMany({
        where: { deletedAt: null, isSandbox: false, startsAt: { gte: today, lt: tomorrow }, OR: [{ projectId: null }, { project: { workspaceId: ws } }] },
        select: { id: true, title: true, startsAt: true, meetLink: true },
        orderBy: { startsAt: "asc" },
      }),
      db.message.findMany({
        where: { deletedAt: null, channel: { workspaceId: ws, kind: "COMPANY", name: ANNOUNCEMENTS, deletedAt: null } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { id: true, body: true, createdAt: true, authorId: true },
      }),
      db.auditLog.findMany({
        where: { workspaceId: ws, NOT: { action: { startsWith: "auth." } } },
        orderBy: { at: "desc" },
        take: 8,
        select: { id: true, actorId: true, action: true, after: true, at: true },
      }),
    ]);

    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const cityName = new Map(cities.map((c) => [c.id, c.name]));

    // ------------------------------------------------------------- headline
    const receivables =
      invoiceTotals && invoicePayments && invoiceCredits && invoiceDebits
        ? round2(num(invoiceTotals._sum.total) - num(invoicePayments._sum.amount) - num(invoiceCredits._sum.amount) + num(invoiceDebits._sum.amount))
        : null;

    // ----------------------------------------------------------- city strip
    const revenueBy = new Map(monthRevenue.map((m) => [m.cityId, num(m._sum.taxableAmount)]));
    const expenseBy = new Map(monthExpenses.map((e) => [e.city_id, Number(e.amount)]));
    const lowBy = new Map(lowStock.map((r) => [r.city_id, Number(r.n)]));
    const overdueBy = new Map(overdueByCity.map((o) => [o.cityId, o._count._all]));

    // --------------------------------------------------------- project list
    const progress = new Map<string, { done: number; total: number }>();
    for (const t of upcomingTasks) {
      const p = progress.get(t.projectId) ?? { done: 0, total: 0 };
      p.total += t._count._all;
      if (t.status === "COMPLETED") p.done += t._count._all;
      progress.set(t.projectId, p);
    }
    const severity: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

    return {
      monthLabel: now.toLocaleDateString("en-IN", { month: "long", timeZone: "Asia/Kolkata" }),
      stats: {
        activeProjects: health.reduce((s, h) => s + h._count._all, 0),
        atRisk: health.find((h) => h.health === "RED")?._count._all ?? 0,
        onTrack: health.find((h) => h.health === "GREEN")?._count._all ?? 0,
        bookedRevenue: can("budgets:view") ? round2(health.reduce((s, h) => s + num(h._sum?.revenue), 0)) : null,
        collected: collected ? round2(num(collected._sum.amount)) : null,
        receivables,
        openInvoices: invoiceTotals?._count._all ?? null,
        pipelineValue: pipeline ? round2(num(pipeline._sum.value)) : null,
        openDeals: pipeline?._count._all ?? null,
      },
      cities: cities.map((c) => {
        const revenue = revenueBy.get(c.id) ?? 0;
        const expenses = expenseBy.get(c.id) ?? 0;
        return {
          id: c.id,
          name: c.name,
          isHq: c.isHq,
          revenue: can("invoices:view") ? round2(revenue) : null,
          netPct: can("invoices:view") && revenue > 0 ? round2(((revenue - expenses) / revenue) * 100) : null,
          lowStock: can("inventory:view") ? lowBy.get(c.id) ?? 0 : null,
          overdue: can("invoices:view") ? overdueBy.get(c.id) ?? 0 : null,
        };
      }),
      queue: queue.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        flowId: s.flowInstance.id,
        flow: s.flowInstance.name,
        dueAt: s.readyAt ? new Date(s.readyAt.getTime() + s.slaMinutes * 60_000) : null,
      })),
      waiting: waiting
        .map((s) => ({
          id: s.id,
          name: s.name,
          flow: s.flowInstance.name,
          on: [...new Set(s.dependsOn.filter((d) => d.dependsOnStep.status !== "COMPLETED").map((d) => nameOf.get(d.dependsOnStep.ownerId) ?? "someone"))],
        }))
        .filter((w) => w.on.length > 0),
      flows:
        flows?.map((f) => ({
          id: f.id,
          name: f.name,
          done: f.steps.filter((s) => s.status === "COMPLETED").length,
          blocked: f.steps.some((s) => s.status === "BLOCKED" || s.status === "ESCALATED"),
          total: f.steps.length,
        })) ?? null,
      projects: projects.map((p) => {
        const pr = progress.get(p.id);
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          city: cityName.get(p.cityId) ?? "—",
          eventDate: p.eventDate,
          eventDateText: p.eventDateText,
          pm: nameOf.get(p.pmId) ?? "—",
          status: p.status,
          health: p.health,
          progress: pr && pr.total ? Math.round((pr.done / pr.total) * 100) : null,
        };
      }),
      approvals: approvals?.map((a) => ({ id: a.id, title: a.title, type: a.type, project: a.project })) ?? null,
      risks:
        risks
          ?.sort((a, b) => (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9))
          .slice(0, 4)
          .map((r) => ({ id: r.id, title: r.title, severity: r.severity, project: r.project, owner: nameOf.get(r.ownerId) ?? "—" })) ?? null,
      meetings,
      announcements: announcements.map((m) => ({ id: m.id, text: m.body, at: m.createdAt, by: m.authorId ? nameOf.get(m.authorId) ?? "Someone" : "Podium" })),
      canPostAnnouncement: user.roleNames.some((r) => MANAGER_ROLES.includes(r)),
      activity: activity.map((a) => ({
        id: a.id,
        who: a.actorId ? nameOf.get(a.actorId) ?? "Someone" : "Podium",
        text: describe(a.action, a.after as Record<string, unknown> | null),
        at: a.at,
      })),
    };
  }

  /** Posts to the company #announcements channel, creating it the first time. */
  async announce(user: RequestUser, text: string) {
    if (!user.roleNames.some((r) => MANAGER_ROLES.includes(r))) {
      throw new ForbiddenException("Only the Founder, Admin or Operations can post announcements.");
    }
    const db = this.prisma.client;
    const channel =
      (await db.channel.findFirst({ where: { workspaceId: user.workspaceId, kind: "COMPANY", name: ANNOUNCEMENTS, deletedAt: null } })) ??
      (await db.channel.create({
        data: { workspaceId: user.workspaceId, kind: "COMPANY", name: ANNOUNCEMENTS, description: "Company-wide announcements, shown on Home" },
      }));
    const message = await db.message.create({ data: { channelId: channel.id, authorId: user.id, body: text } });
    await db.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "announcement.posted",
        entityType: "message",
        entityId: message.id,
        after: { text: text.slice(0, 140) },
      },
    });
    return { ok: true };
  }

  /** Counts for the sidebar badges — cheap enough to poll. */
  async navCounts(user: RequestUser) {
    const db = this.prisma.client;
    const scope = this.cityScope.scopeFilter(user);
    const can = (p: string) => user.permissions.has(p);
    const [myQueue, approvals, overdue, lowStock, myTasks, chatUnread, mailUnread] = await Promise.all([
      db.flowStep.count({ where: { ownerId: user.id, status: { in: ["READY", "ACTIVE"] }, deletedAt: null } }),
      can("approvals:view") ? db.approval.count({ where: { status: "PENDING", deletedAt: null, project: { workspaceId: user.workspaceId, ...scope } } }) : 0,
      can("invoices:view") ? db.invoice.count({ where: { workspaceId: user.workspaceId, deletedAt: null, status: "OVERDUE", ...scope } }) : 0,
      can("inventory:view")
        ? db.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n
            FROM inventory_balances b
            JOIN inventory_items i ON i.id = b.sku_id
            WHERE i.workspace_id = ${user.workspaceId}::uuid AND i.deleted_at IS NULL AND b.reorder_level > 0 AND b.qty_on_hand <= b.reorder_level`.then((r) => r[0]?.n ?? 0)
        : 0,
      db.task.count({ where: { ownerId: user.id, deletedAt: null, status: { not: "COMPLETED" }, project: { workspaceId: user.workspaceId, deletedAt: null, ...scope } } }),
      totalUnread(db, user),
      this.google.unreadCount(user),
    ]);
    return { myQueue, approvals, overdueInvoices: overdue, lowStock, myWork: myQueue + myTasks, chatUnread, mailUnread };
  }
}

/**
 * One readable line per audit entry ("uploaded Joining Letter - Riya.pdf").
 * Only facts recorded in the entry are used; an unfamiliar action falls
 * back to its own words rather than an invented description.
 */
export function describe(action: string, after: Record<string, unknown> | null): string {
  const a = after ?? {};
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const t = (k: string) => s(k).replace(/_/g, " ").toLowerCase();
  const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
  switch (action) {
    case "document.create":
      return `uploaded ${s("name") || "a document"}`;
    case "document.new_version":
      return `uploaded a new version of ${s("fileName") || "a document"}`;
    case "document.delete":
      return "deleted a document";
    case "letter.generated": {
      const tpl = s("template").replace(/-/g, " ");
      return `generated ${article(tpl)} ${tpl}${s("subject") ? ` for ${s("subject")}` : ""}`;
    }
    case "leave.requested":
      return `logged ${t("type") ? `${t("type")} ` : ""}leave${s("for") ? ` for ${s("for")}` : ""}`;
    case "leave.approved":
      return `approved leave${s("for") ? ` for ${s("for")}` : ""}`;
    case "leave.rejected":
      return `declined leave${s("for") ? ` for ${s("for")}` : ""}`;
    case "attendance.set":
      return `marked attendance as ${t("status")}`;
    case "freelancer.booked":
      return `booked ${s("name")}${s("event") ? ` for ${s("event")}` : ""}`;
    case "freelancer.released":
      return `released ${s("name")}`;
    case "announcement.posted":
      return `posted an announcement: “${s("text")}”`;
    case "project.create":
      return `created project ${s("name")}`;
    case "project.update":
      return `updated project ${s("name")}`;
    case "project.member_added":
      return "added someone to a project crew";
    case "task.create":
      return `added task “${s("name")}”`;
    case "task.update":
      return `updated task “${s("name")}”${s("status") ? ` → ${t("status")}` : ""}`;
    case "risk.create":
      return `raised risk “${s("title")}”`;
    case "risk.update":
      return `updated risk “${s("title")}”`;
    case "approval.create":
      return `requested approval “${s("title")}”`;
    case "event_day.incident_logged":
      return `logged ${article(t("severity"))} ${t("severity")} event-day incident`;
    case "invoice.issue":
      return `issued invoice ${s("invoiceNo")}`.trim();
    case "invoice.create_draft":
      return "drafted an invoice";
    case "invoice.payment_recorded":
      return "recorded a payment";
    case "lead.create":
      return `added lead ${s("name")}`;
    case "lead.stage_changed":
      return `moved lead ${s("name")} to ${t("stage")}`;
    case "expense.submit":
      return "submitted an expense";
    case "chat.post_message":
      return "posted in chat";
    case "auth.password_set_first_login":
      return "set their password at first sign-in";
    case "auth.password_reset":
      return "reset a password";
    case "user.password_reset_requested":
      return "requested a password reset";
    case "google.connected":
      return `connected the Google account ${s("googleEmail")}`;
    case "google.disconnected":
      return "disconnected a Google account";
    case "settings.updated":
      return "changed workspace settings";
    case "sop.created":
      return `wrote the SOP "${s("title")}"`;
    case "sop.new_version":
      return `published a new version of "${s("title")}"`;
    case "sop.archived":
      return `archived the SOP "${s("title")}"`;
    case "meeting.scheduled":
      return `scheduled "${s("title")}"`;
    case "meeting.cancelled":
      return `cancelled the meeting "${s("title")}"`;
    case "meeting.action_item_added":
      return `added an action item: "${s("text")}"`;
    case "chat.channel_created":
      return `created the channel #${s("name")}`;
    case "inventory.store_created":
      return `created the ${s("name")}`;
    case "inventory.item_created":
      return `added stock item ${s("name")} (${s("sku")})`;
    case "inventory.item_updated":
      return `updated stock item ${s("sku")}`;
    case "inventory.items_imported":
      return "imported stock items from the product catalogue";
    case "inventory.movement":
      return "recorded a stock movement";
    case "inventory.reserved":
      return `reserved stock at ${s("store")} for an event`;
    case "inventory.released":
      return "released reserved stock";
    case "event_day.checkin":
      return "checked a crew member in";
    case "runsheet.create":
      return "created a run-of-show";
    case "runsheet_item.done":
      return "ticked off a run-of-show cue";
    default:
      return action.replace(/[._]/g, " ");
  }
}
