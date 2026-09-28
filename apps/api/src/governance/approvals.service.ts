import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateApprovalInput, DecideApprovalInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  async list(user: RequestUser, projectId?: string) {
    const scope = this.cityScope.scopeFilter(user);
    // An approval with no project (a store purchase request raised outside
    // any event) was dropped by the old `project: {…}` condition, which
    // matches nothing when there is no project. Such rows carry no workspace
    // of their own, so they are kept only when their requester is in this
    // workspace (checked below, against the requester lookup).
    const rows = await this.prisma.client.approval.findMany({
      where: {
        deletedAt: null,
        ...(projectId
          ? { projectId, project: { workspaceId: user.workspaceId, ...scope } }
          : { OR: [{ project: { workspaceId: user.workspaceId, ...scope } }, { projectId: null }] }),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    // Approval has no relation to its requester, so names come from one lookup.
    const requesters = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.requesterId))] }, workspaceId: user.workspaceId },
      select: { id: true, name: true },
    });
    const nameOf = new Map(requesters.map((u) => [u.id, u.name]));
    return rows
      .filter((r) => r.projectId !== null || nameOf.has(r.requesterId))
      .map((r) => ({ ...r, requester: { id: r.requesterId, name: nameOf.get(r.requesterId) ?? "—" } }));
  }

  async create(user: RequestUser, input: CreateApprovalInput) {
    const project = await this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return this.prisma.client.approval.create({ data: { ...input, requesterId: user.id, status: "PENDING" } });
  }

  /**
   * PENDING -> APPROVED | REJECTED, once, never by the requester.
   *
   * BUG-009 (found in the 2026-09-12 CTO audit, fixed here in Phase B.1):
   * this method used to update the row unconditionally — no check that it
   * was still PENDING (so a settled approval could be silently re-decided,
   * flipping an already-APPROVED spend to REJECTED or back with no trace of
   * the original decision), and no check that the decider wasn't the person
   * who requested it in the first place. Both guards mirror
   * ExpensesService.decide() from Phase B, which is the same state machine
   * on a different table: PENDING once, and never the requester, regardless
   * of role or permission grant — approvals:approve alone does not prove the
   * decider is a different person from the requester.
   *
   * NOTE: this is the GENERIC approval path (CREATIVE/BUDGET/CLIENT/VENDOR/
   * PAYMENT-type approvals reachable from the /approvals screen). It is a
   * distinct code path from ProcurementService.decideRequestApproval(),
   * which already had both guards from an earlier audit cycle — verified by
   * reading it before touching this file, per the instruction to check for
   * dependents before changing behavior. Nothing else in this codebase calls
   * ApprovalsService.decide(), and no existing test exercised it before this
   * change (confirmed by search), so there was nothing relying on the old,
   * unguarded re-decide behavior.
   */
  async decide(user: RequestUser, id: string, input: DecideApprovalInput) {
    return this.prisma.client.$transaction(async (tx) => {
      const approval = await tx.approval.findFirst({
        where: { id, deletedAt: null },
        include: { project: true, purchaseRequest: true },
      });
      if (!approval) throw new NotFoundException("Approval not found.");

      // An approval hangs off either a project or a purchase request — the latter
      // because store-replenishment purchases have no project but must still pass
      // the gate. Whichever it is, the city grant is checked, never skipped.
      if (approval.project) {
        if (approval.project.workspaceId !== user.workspaceId) throw new NotFoundException("Approval not found.");
        this.cityScope.assertCanAccessCity(user, approval.project.cityId);
      } else if (approval.purchaseRequest) {
        this.cityScope.assertCanAccessCity(user, approval.purchaseRequest.cityId);
      } else {
        throw new NotFoundException("Approval not found.");
      }

      if (approval.requesterId === user.id) {
        throw new ForbiddenException(
          "You requested this approval, so you cannot decide it yourself. Someone else holding approvals:approve must review it.",
        );
      }
      if (approval.status !== "PENDING") {
        throw new ConflictException(
          `This approval is already ${approval.status} — a settled approval cannot be decided again. ` +
            "Raise a new approval if something needs to change.",
        );
      }

      // The status guard is repeated in the WHERE clause so two approvers
      // deciding at the same moment cannot both succeed: the second update
      // matches zero rows rather than silently overwriting the first.
      const updated = await tx.approval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: { status: input.decision, decisionReason: input.reason, decidedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ConflictException("This approval was decided by someone else a moment ago.");
      }

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: input.decision === "APPROVED" ? "approval.approved" : "approval.rejected",
          entityType: "approval",
          entityId: approval.id,
          before: { status: "PENDING" },
          after: { status: input.decision, requesterId: approval.requesterId, reason: input.reason ?? null },
        },
      });

      return tx.approval.findUniqueOrThrow({ where: { id: approval.id } });
    });
  }
}
