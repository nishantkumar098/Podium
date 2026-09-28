import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

/** A line that reads as a step: "1." / "1)" / "-" / "*" / "•". */
const STEP_LINE = /^\s*(\d+[.)]|[-*•])\s+\S/;

export function countSteps(body: string): number {
  return body.split("\n").filter((l) => STEP_LINE.test(l)).length;
}

/**
 * Knowledge / SOPs: the company's standard operating procedures.
 *
 * An SOP is never edited in place — each save writes a new numbered version,
 * so "which version was in force when that event ran" stays answerable. The
 * current version is simply the highest-numbered one.
 */
@Injectable()
export class SopsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertCanWrite(user: RequestUser) {
    if (!user.permissions.has("playbooks:create") && !user.permissions.has("playbooks:edit")) {
      throw new ForbiddenException("You don't have permission to write SOPs.");
    }
  }

  async list(user: RequestUser) {
    const db = this.prisma.client;
    const sops = await db.sop.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null },
      include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } },
      orderBy: [{ department: "asc" }, { title: "asc" }],
    });
    const ownerIds = [...new Set(sops.map((s) => s.ownerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
    const ownerName = new Map(owners.map((o) => [o.id, o.name]));
    return sops.map(({ versions, ...s }) => ({
      ...s,
      owner: s.ownerId ? { id: s.ownerId, name: ownerName.get(s.ownerId) ?? "—" } : null,
      current: versions[0] ? { versionNo: versions[0].versionNo, stepsCount: versions[0].stepsCount, body: versions[0].body, createdAt: versions[0].createdAt } : null,
    }));
  }

  async get(user: RequestUser, id: string) {
    const sop = await this.prisma.client.sop.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
      include: { versions: { orderBy: { versionNo: "desc" } } },
    });
    if (!sop) throw new NotFoundException("SOP not found.");
    return sop;
  }

  async create(user: RequestUser, input: { title: string; department: string; body: string; ownerId?: string | null }) {
    this.assertCanWrite(user);
    const db = this.prisma.client;
    const sop = await db.$transaction(async (tx) => {
      const created = await tx.sop.create({
        data: { workspaceId: user.workspaceId, title: input.title.trim(), department: input.department.trim(), ownerId: input.ownerId ?? user.id },
      });
      await tx.sopVersion.create({
        data: { sopId: created.id, versionNo: 1, body: input.body, stepsCount: countSteps(input.body), createdById: user.id },
      });
      await tx.auditLog.create({
        data: { workspaceId: user.workspaceId, actorId: user.id, action: "sop.created", entityType: "sop", entityId: created.id, after: { title: created.title, department: created.department } },
      });
      return created;
    });
    return sop;
  }

  /** A new version of an existing SOP. The previous one is kept, never overwritten. */
  async addVersion(user: RequestUser, id: string, body: string) {
    this.assertCanWrite(user);
    const db = this.prisma.client;
    const sop = await db.sop.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!sop) throw new NotFoundException("SOP not found.");
    const last = await db.sopVersion.findFirst({ where: { sopId: sop.id }, orderBy: { versionNo: "desc" }, select: { versionNo: true } });
    const versionNo = (last?.versionNo ?? 0) + 1;
    const version = await db.sopVersion.create({ data: { sopId: sop.id, versionNo, body, stepsCount: countSteps(body), createdById: user.id } });
    await db.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action: "sop.new_version", entityType: "sop", entityId: sop.id, after: { title: sop.title, versionNo } },
    });
    return version;
  }

  async update(user: RequestUser, id: string, input: { title?: string; department?: string; ownerId?: string | null }) {
    this.assertCanWrite(user);
    const sop = await this.prisma.client.sop.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!sop) throw new NotFoundException("SOP not found.");
    return this.prisma.client.sop.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.department !== undefined ? { department: input.department.trim() } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
    });
  }

  /** Archive. Versions are kept — an SOP that governed past events stays readable. */
  async archive(user: RequestUser, id: string) {
    this.assertCanWrite(user);
    const sop = await this.prisma.client.sop.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!sop) throw new NotFoundException("SOP not found.");
    await this.prisma.client.sop.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.prisma.client.auditLog.create({
      data: { workspaceId: user.workspaceId, actorId: user.id, action: "sop.archived", entityType: "sop", entityId: id, after: { title: sop.title } },
    });
    return { ok: true };
  }
}
