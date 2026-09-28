import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@podium/db";
import { PrismaService } from "../common/prisma/prisma.service";
import { describe } from "../dashboard/dashboard.service";
import type { RequestUser } from "../common/types";
import { ORG_WIDE_ROLES } from "../common/rbac/model";

const AUDIT_ROLES = ORG_WIDE_ROLES;
const PAGE = 100;

/**
 * The audit log: who did what, and when. Append-only — nothing in Podium
 * updates or deletes an `audit_logs` row, and this service only reads.
 *
 * Restricted to the Founder and Admin: the log spans every city and every
 * person, including password resets and pay-adjacent approvals.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  private assert(user: RequestUser) {
    if (!user.roleNames.some((r) => AUDIT_ROLES.includes(r))) {
      throw new ForbiddenException("Only the Founder or an Admin can read the audit log.");
    }
  }

  async list(user: RequestUser, opts: { actorId?: string; action?: string; entityType?: string; from?: string; to?: string; search?: string; cursor?: string; limit?: number }) {
    this.assert(user);
    const db = this.prisma.client;
    const take = Math.min(opts.limit ?? PAGE, 500);
    const where: Prisma.AuditLogWhereInput = {
      workspaceId: user.workspaceId,
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.action ? { action: { startsWith: opts.action } } : {}),
      ...(opts.entityType ? { entityType: opts.entityType } : {}),
      ...(opts.from || opts.to ? { at: { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) } } : {}),
      ...(opts.search ? { OR: [{ action: { contains: opts.search, mode: "insensitive" } }, { entityType: { contains: opts.search, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { at: "desc" },
        take: take + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        include: { actor: { select: { id: true, name: true } } },
      }),
      db.auditLog.count({ where }),
    ]);
    const page = rows.slice(0, take);
    return {
      total,
      nextCursor: rows.length > take ? page[page.length - 1]?.id ?? null : null,
      rows: page.map((r) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        ip: r.ip,
        who: r.actor?.name ?? "Podium",
        actorId: r.actorId,
        text: describe(r.action, r.after as Record<string, unknown> | null),
        before: r.before,
        after: r.after,
      })),
    };
  }

  /** The distinct actions and entity types present, for the filters. */
  async filters(user: RequestUser) {
    this.assert(user);
    const db = this.prisma.client;
    const [actions, entityTypes, actors] = await Promise.all([
      db.auditLog.groupBy({ by: ["action"], where: { workspaceId: user.workspaceId }, _count: { _all: true }, orderBy: { _count: { action: "desc" } }, take: 60 }),
      db.auditLog.groupBy({ by: ["entityType"], where: { workspaceId: user.workspaceId }, _count: { _all: true } }),
      db.auditLog.groupBy({ by: ["actorId"], where: { workspaceId: user.workspaceId }, _count: { _all: true } }),
    ]);
    const ids = actors.map((a) => a.actorId).filter((x): x is string => !!x);
    const people = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return {
      actions: actions.map((a) => ({ action: a.action, count: a._count._all })),
      entityTypes: entityTypes.map((e) => ({ entityType: e.entityType, count: e._count._all })).sort((a, b) => b.count - a.count),
      actors: actors
        .filter((a) => a.actorId)
        .map((a) => ({ id: a.actorId!, name: nameOf.get(a.actorId!) ?? "—", count: a._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }
}
