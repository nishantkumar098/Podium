import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateProjectInput, UpdateProjectInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { AccessScopeService } from "../common/rbac/access-scope.service";
import { PROJECT_FIELD_POLICY, VENDOR_FIELD_POLICY, redact, redactAll } from "../common/rbac/field-policy";
import { SAFE_USER_INCLUDE, SAFE_USER_SELECT } from "../common/safe-user";
import { recomputeProjectHealth } from "../common/project-health";
import type { RequestUser } from "../common/types";

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly accessScope: AccessScopeService,
  ) {}

  /**
   * The Projects list, with each project's crew (PM + members, for the
   * avatar stack) and task progress.
   *
   * Written as independent queries run side by side rather than one query
   * with `include`s: Prisma runs each include as a further sequential round
   * trip, and with the database in Sydney every trip costs ~0.3–0.6 s. Here
   * the whole screen costs about one trip.
   */
  async list(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    // City access AND record-level reach (crew, department, dependency) —
    // see AccessScopeService. Every related query below reuses the same
    // fragment, so a project hidden from the list cannot reappear through
    // its members, tasks or client.
    const inScope = this.accessScope.projectWhere(user, cityId);
    const [projects, clients, cities, people, members, taskCounts] = await Promise.all([
      db.project.findMany({ where: inScope, orderBy: { eventDate: "asc" } }),
      db.client.findMany({ where: { workspaceId: user.workspaceId, projects: { some: inScope } }, select: { id: true, name: true } }),
      db.city.findMany({ where: { workspaceId: user.workspaceId }, select: { id: true, name: true } }),
      db.user.findMany({ where: { workspaceId: user.workspaceId }, select: SAFE_USER_SELECT }),
      db.projectMember.findMany({ where: { deletedAt: null, project: inScope }, select: { projectId: true, userId: true } }),
      db.task.groupBy({ by: ["projectId", "status"], where: { deletedAt: null, project: inScope }, _count: { _all: true } }),
    ]);
    const clientBy = new Map(clients.map((c) => [c.id, c]));
    const cityBy = new Map(cities.map((c) => [c.id, c]));
    const personBy = new Map(people.map((p) => [p.id, p]));
    const progress = new Map<string, { done: number; total: number }>();
    for (const t of taskCounts) {
      const p = progress.get(t.projectId) ?? { done: 0, total: 0 };
      p.total += t._count._all;
      if (t.status === "COMPLETED") p.done += t._count._all;
      progress.set(t.projectId, p);
    }
    const crewBy = new Map<string, string[]>();
    for (const m of members) crewBy.set(m.projectId, [...(crewBy.get(m.projectId) ?? []), m.userId]);

    return projects.map((p) => {
      const pm = personBy.get(p.pmId);
      const team = [...new Set([p.pmId, ...(crewBy.get(p.id) ?? [])])]
        .map((id) => personBy.get(id))
        .filter((u): u is NonNullable<typeof u> => !!u)
        .map((u) => ({ id: u.id, name: u.name }));
      return {
        // Revenue and cost are company finance sitting on an operational
        // row; redact() drops them for anyone without budgets:view.
        ...redact(user, PROJECT_FIELD_POLICY, p as unknown as Record<string, unknown>),
        client: clientBy.get(p.clientId) ?? { id: p.clientId, name: "—" },
        city: cityBy.get(p.cityId) ?? { id: p.cityId, name: "—" },
        pm: pm ?? { id: p.pmId, name: "—", email: null, dept: null, isActive: false },
        team,
        tasks: progress.get(p.id) ?? { done: 0, total: 0 },
      };
    });
  }

  /**
   * One project with everything its tabs show. Same approach as list(): the
   * project row and each related set are separate queries fired together,
   * so the page costs a couple of round trips instead of a dozen.
   */
  async get(user: RequestUser, id: string) {
    const db = this.prisma.client;
    const own = { projectId: id, project: { workspaceId: user.workspaceId } };
    const ofThis = { some: { id, workspaceId: user.workspaceId } };
    const [project, client, city, pm, members, vendors, tasks, risks, approvals, meetings, flowInstances, paid, activityRows] = await Promise.all([
      db.project.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } }),
      db.client.findFirst({ where: { projects: ofThis } }),
      db.city.findFirst({ where: { projects: ofThis } }),
      db.user.findFirst({ where: { projectsAsPm: ofThis }, select: SAFE_USER_SELECT }),
      db.projectMember.findMany({
        where: { ...own, deletedAt: null },
        include: { user: { select: { ...SAFE_USER_SELECT, primaryRole: { select: { name: true } } } } },
      }),
      db.projectVendor.findMany({ where: { ...own, deletedAt: null }, include: { vendor: true } }),
      db.task.findMany({
        where: { ...own, deletedAt: null },
        include: { owner: { select: { id: true, name: true } } },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      }),
      db.risk.findMany({ where: { ...own, deletedAt: null }, include: { owner: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } }),
      db.approval.findMany({ where: { ...own, deletedAt: null }, orderBy: { createdAt: "desc" } }),
      db.meeting.findMany({
        where: { ...own, deletedAt: null, isSandbox: false },
        include: { _count: { select: { actionItems: true } } },
        orderBy: { startsAt: "desc" },
      }),
      db.flowInstance.findMany({ where: { ...own }, include: { steps: true } }),
      db.payment.aggregate({ where: { invoice: { projectId: id, workspaceId: user.workspaceId, deletedAt: null } }, _sum: { amount: true } }),
      // Entries about the project itself, or any record that carries its id
      // (tasks, risks, crew, check-ins and incidents all record projectId).
      db.auditLog.findMany({
        where: { workspaceId: user.workspaceId, OR: [{ entityId: id }, { after: { path: ["projectId"], equals: id } }] },
        orderBy: { at: "desc" },
        take: 30,
        include: { actor: { select: { name: true } } },
      }),
    ]);
    if (!project || !client || !city || !pm) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    // The detail view must agree with the list exactly: a record that the
    // list hides and an id can still open is not access control.
    await this.accessScope.assertProject(user, id, db);

    const requesterIds = [...new Set(approvals.map((a) => a.requesterId))];
    const requesters = requesterIds.length ? await db.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true } }) : [];
    const requesterName = new Map(requesters.map((u) => [u.id, u.name]));

    return {
      ...redact(user, PROJECT_FIELD_POLICY, project as unknown as Record<string, unknown>),
      client,
      city,
      pm,
      members,
      vendors: redactAll(user, VENDOR_FIELD_POLICY, vendors.map((pv) => ({ ...pv, vendor: redact(user, VENDOR_FIELD_POLICY, pv.vendor as unknown as Record<string, unknown>) })) as unknown as Array<Record<string, unknown>>),
      tasks,
      risks,
      meetings,
      flowInstances,
      paid: paid._sum.amount?.toNumber() ?? 0,
      approvals: approvals.map((a) => ({ ...a, requesterName: requesterName.get(a.requesterId) ?? null })),
      activity: activityRows.map((a) => ({ id: a.id, who: a.actor?.name ?? "Podium", action: a.action, entityType: a.entityType, after: a.after, at: a.at })),
    };
  }

  /**
   * Resources: every internal, active person with how much live work they
   * carry — upcoming projects they run or crew, and open tasks. The screen
   * shows load relative to the busiest person, because Podium holds no
   * capacity/hours figure to measure against.
   */
  async resources(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    const scope = this.cityScope.scopeFilter(user, cityId);
    const live = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      status: { notIn: ["COMPLETED", "CANCELLED"] as ("COMPLETED" | "CANCELLED")[] },
      ...scope,
    };
    const [people, projects, openTasks] = await Promise.all([
      db.user.findMany({
        where: { workspaceId: user.workspaceId, isActive: true, deletedAt: null, isExternal: false },
        select: { id: true, name: true, dept: true, primaryRole: { select: { name: true } }, primaryCity: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
      db.project.findMany({
        where: { ...live, eventDate: { gte: startOfToday() } },
        select: { id: true, name: true, eventDate: true, pmId: true, members: { where: { deletedAt: null }, select: { userId: true } } },
        orderBy: { eventDate: "asc" },
      }),
      db.task.groupBy({ by: ["ownerId"], where: { deletedAt: null, status: { not: "COMPLETED" }, project: live }, _count: { _all: true } }),
    ]);
    const tasksBy = new Map(openTasks.map((t) => [t.ownerId, t._count._all]));
    return people.map((p) => {
      const mine = projects.filter((pr) => pr.pmId === p.id || pr.members.some((m) => m.userId === p.id));
      return {
        id: p.id,
        name: p.name,
        role: p.primaryRole?.name ?? null,
        dept: p.dept,
        city: p.primaryCity?.name ?? null,
        activeProjects: mine.length,
        nextProject: mine[0] ? { id: mine[0].id, name: mine[0].name, eventDate: mine[0].eventDate } : null,
        openTasks: tasksBy.get(p.id) ?? 0,
      };
    });
  }

  async addMember(user: RequestUser, projectId: string, userId: string, roleOnProject: "PROJECT_MANAGER" | "TEAM_MEMBER" | "OBSERVER") {
    const project = await this.loadForEdit(user, projectId);
    const person = await this.prisma.client.user.findFirst({ where: { id: userId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!person) throw new BadRequestException("That person is not a user in this workspace.");
    const existing = await this.prisma.client.projectMember.findFirst({ where: { projectId: project.id, userId } });
    if (existing) {
      return this.prisma.client.projectMember.update({ where: { id: existing.id }, data: { deletedAt: null, roleOnProject } });
    }
    return this.prisma.client.projectMember.create({ data: { projectId: project.id, userId, roleOnProject } });
  }

  async removeMember(user: RequestUser, projectId: string, userId: string) {
    const project = await this.loadForEdit(user, projectId);
    await this.prisma.client.projectMember.updateMany({
      where: { projectId: project.id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async addVendor(user: RequestUser, projectId: string, vendorId: string) {
    const project = await this.loadForEdit(user, projectId);
    const vendor = await this.prisma.client.vendor.findFirst({ where: { id: vendorId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!vendor) throw new BadRequestException("Vendor not found.");
    const existing = await this.prisma.client.projectVendor.findUnique({ where: { projectId_vendorId: { projectId: project.id, vendorId } } });
    if (existing) return this.prisma.client.projectVendor.update({ where: { id: existing.id }, data: { deletedAt: null } });
    return this.prisma.client.projectVendor.create({ data: { projectId: project.id, vendorId } });
  }

  async removeVendor(user: RequestUser, projectId: string, vendorId: string) {
    const project = await this.loadForEdit(user, projectId);
    await this.prisma.client.projectVendor.updateMany({
      where: { projectId: project.id, vendorId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private async loadForEdit(user: RequestUser, projectId: string) {
    const project = await this.prisma.client.project.findFirst({ where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null } });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return project;
  }

  async create(user: RequestUser, input: CreateProjectInput) {
    this.cityScope.assertCanAccessCity(user, input.cityId);
    const project = await this.prisma.client.project.create({
      data: {
        workspaceId: user.workspaceId,
        name: input.name,
        clientId: input.clientId,
        playbookId: input.playbookId,
        type: input.type,
        cityId: input.cityId,
        eventDate: input.eventDate,
        pmId: input.pmId,
        revenue: input.revenue,
        estCost: input.estCost,
        createdById: user.id,
        updatedById: user.id,
      },
    });
    // Auto-create the project's chat channel, mirroring the prototype's
    // CHANNELS auto-creation on project creation (blueprint §5A/§23).
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    await this.prisma.client.channel.create({
      data: { workspaceId: user.workspaceId, name: slug, kind: "PROJECT", projectId: project.id },
    });
    return project;
  }

  async update(user: RequestUser, id: string, input: UpdateProjectInput) {
    const existing = await this.loadForEdit(user, id);
    if (input.cityId) this.cityScope.assertCanAccessCity(user, input.cityId);
    const updated = await this.prisma.client.project.update({
      where: { id: existing.id },
      data: { ...input, updatedById: user.id },
    });
    await recomputeProjectHealth(this.prisma.client, existing.id);
    return updated;
  }

  /**
   * Archive a project. Soft delete only — the row, its tasks, its flow
   * instances and its invoices all stay, because a project is the spine every
   * other record hangs off and a hard delete would take them with it.
   */
  async archive(user: RequestUser, id: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return this.prisma.client.project.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById: user.id },
    });
  }

  /**
   * Un-archive a project — and the one place BUG-007's invariant can be met
   * from the other direction.
   *
   * The invariant is ONE LEAD CONVERSION -> AT MOST ONE LIVE INITIAL PROJECT.
   * Archiving a converted project frees its lead to be converted again, which
   * is deliberate: a project archived in error must not make the lead
   * permanently unconvertible. But that means a lead can end up with an
   * archived conversion AND a live one, and restoring the archived one would
   * put two live projects on a single conversion.
   *
   * The database refuses that outright — `projects_one_live_conversion_per_lead`
   * would raise a P2002. What a user must never see is that P2002. A raw
   * constraint error names an index, leaks the schema, and arrives as a 500
   * that reads like a bug in Podium rather than a decision they need to make.
   * So the conflict is detected here, first, and returned as a 409 naming the
   * project that currently holds the conversion and what to do about it.
   *
   * The `catch` after it is not redundant: two simultaneous restores both pass
   * the check and only the database can separate them. That path produces the
   * same 409, never a 500.
   */
  async restore(user: RequestUser, id: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: { not: null } },
    });
    if (!project) throw new NotFoundException("No archived project with that id.");
    this.cityScope.assertCanAccessCity(user, project.cityId);

    if (project.convertedFromLeadId) {
      const occupant = await this.prisma.client.project.findFirst({
        where: {
          convertedFromLeadId: project.convertedFromLeadId,
          deletedAt: null,
          workspaceId: user.workspaceId,
        },
        select: { id: true, name: true },
      });
      if (occupant) throw new ConflictException(this.conversionConflict(occupant));
    }

    try {
      return await this.prisma.client.project.update({
        where: { id },
        data: { deletedAt: null, updatedById: user.id },
      });
    } catch (err) {
      if (!isConversionUniqueViolation(err)) throw err;
      const occupant = await this.prisma.client.project.findFirst({
        where: { convertedFromLeadId: project.convertedFromLeadId, deletedAt: null },
        select: { id: true, name: true },
      });
      throw new ConflictException(this.conversionConflict(occupant));
    }
  }

  private conversionConflict(occupant: { id: string; name: string } | null) {
    return (
      "This project came from a lead conversion, and that lead has since been converted again. " +
      `Its live project is now ${occupant ? `"${occupant.name}" (${occupant.id})` : "another project"}. ` +
      "A conversion can only have one live project at a time — archive that one first if this is the project you want back, " +
      "or create this one as a new project of the same client instead. " +
      "(The client itself may hold as many projects as it likes; the limit is on the conversion, not the client.)"
    );
  }

  /** See recomputeProjectHealth — kept as a method for existing callers. */
  recomputeHealth(projectId: string) {
    return recomputeProjectHealth(this.prisma.client, projectId);
  }
}

/**
 * A Prisma P2002 raised by the conversion index.
 *
 * Matched on the COLUMN, because that is what Prisma actually reports:
 * `meta.target` for this violation is `["converted_from_lead_id"]`, never the
 * index name. Matching on the name looked tidier and silently never matched —
 * the concurrent-restore test got a 500 rather than the 409 it was written to
 * prove, which is the entire failure this function exists to prevent.
 *
 * Narrow on purpose. Only a violation naming this exact column becomes a 409;
 * any other unique violation is a different bug and must keep its 500 rather
 * than be dressed up as a conversion conflict.
 */
const CONVERSION_UNIQUE_COLUMN = "converted_from_lead_id";

function isConversionUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.includes(CONVERSION_UNIQUE_COLUMN);
}

/** Midnight today, India time — events later today still count as upcoming. */
function startOfToday(): Date {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
}
