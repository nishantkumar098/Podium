import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateExpenseInput, DecideExpenseInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

/**
 * Expense claims and their approval workflow (blueprint §18).
 *
 * The state machine is deliberately strict, because this path moves real
 * money out to real people:
 *
 *   PENDING ──approve──> APPROVED ──reimburse──> REIMBURSED
 *      └─────reject────> REJECTED
 *
 * Three rules are enforced here rather than trusted to the caller:
 *
 *  1. **A decision happens once.** Only a PENDING claim can be approved or
 *     rejected. Re-deciding a settled claim is refused, so an approval can
 *     never be quietly flipped after the fact.
 *  2. **Nobody approves their own claim.** The claimant (`userId`) and the
 *     approver are checked to be different people. Self-approved
 *     reimbursement is the textbook expense-fraud path, and a permission
 *     grant alone does not prevent it — a Finance Manager holds
 *     `expenses:approve` and also submits their own claims.
 *  3. **The approver is a real, recorded user id**, not free text, so
 *     "who authorised this payment" always has an answer.
 *
 * NOTE (recorded during Phase B, see docs/STATUS.md): the pre-existing
 * generic `ApprovalsService.decide()` used by procurement enforces NONE of
 * these three — it permits re-deciding a settled approval and does not block
 * self-approval. That is reported as a finding rather than silently copied
 * here; this service does not follow it into that behaviour.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  private async assertProject(user: RequestUser, projectId: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);
    return project;
  }

  /** Loads an expense and enforces workspace + city access via its project. */
  private async loadScoped(user: RequestUser, id: string) {
    const expense = await this.prisma.client.expense.findFirst({
      where: { id, deletedAt: null },
      include: { project: true, user: { select: { id: true, name: true, email: true } } },
    });
    if (!expense || expense.project.workspaceId !== user.workspaceId) throw new NotFoundException("Expense not found.");
    this.cityScope.assertCanAccessCity(user, expense.project.cityId);
    return expense;
  }

  async list(user: RequestUser, opts: { projectId?: string; status?: string; mine?: boolean } = {}) {
    const scope = this.cityScope.scopeFilter(user);
    return this.prisma.client.expense.findMany({
      where: {
        deletedAt: null,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.status ? { status: opts.status as never } : {}),
        ...(opts.mine ? { userId: user.id } : {}),
        project: { workspaceId: user.workspaceId, deletedAt: null, ...scope },
      },
      include: {
        project: { select: { id: true, name: true, cityId: true } },
        user: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { incurredAt: "desc" },
    });
  }

  async get(user: RequestUser, id: string) {
    return this.loadScoped(user, id);
  }

  /**
   * Submits a claim. The claimant is always the authenticated caller — an
   * expense cannot be filed on someone else's behalf, because the claimant
   * is who gets paid.
   */
  async create(user: RequestUser, input: CreateExpenseInput, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.client.expense.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }
    await this.assertProject(user, input.projectId);

    return this.prisma.client.expense.create({
      data: {
        userId: user.id,
        projectId: input.projectId,
        category: input.category.trim(),
        amount: input.amount,
        note: input.note,
        incurredAt: input.incurredAt ?? new Date(),
        status: "PENDING",
        idempotencyKey,
      },
      include: { project: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
    });
  }

  /** PENDING -> APPROVED | REJECTED. Once only, and never by the claimant. */
  async decide(user: RequestUser, id: string, input: DecideExpenseInput) {
    if (input.decision === "REJECTED" && !input.reason) {
      throw new BadRequestException("A rejection needs a reason — the claimant has to know why they are out of pocket.");
    }

    return this.prisma.client.$transaction(async (tx) => {
      const expense = await this.loadScoped(user, id);

      if (expense.userId === user.id) {
        throw new ForbiddenException(
          "You cannot decide your own expense claim. Someone else holding expenses:approve must review it.",
        );
      }
      if (expense.status !== "PENDING") {
        throw new ConflictException(
          `This claim is already ${expense.status} — a settled expense cannot be decided again. ` +
            "Raise a new claim if something needs correcting.",
        );
      }

      // The status guard is repeated in the WHERE clause so two approvers
      // clicking at the same moment cannot both succeed: the second update
      // matches zero rows.
      const updated = await tx.expense.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: input.decision,
          approvedById: user.id,
          decidedAt: new Date(),
          decisionReason: input.reason,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException("This claim was decided by someone else a moment ago.");
      }

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: input.decision === "APPROVED" ? "expense.approved" : "expense.rejected",
          entityType: "expense",
          entityId: id,
          before: { status: "PENDING" },
          after: {
            status: input.decision,
            amount: Number(expense.amount),
            claimantId: expense.userId,
            reason: input.reason ?? null,
          },
        },
      });

      return tx.expense.findUniqueOrThrow({
        where: { id },
        include: {
          project: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
          approvedBy: { select: { id: true, name: true } },
        },
      });
    });
  }

  /** APPROVED -> REIMBURSED. Records that the money actually went out. */
  async reimburse(user: RequestUser, id: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const expense = await this.loadScoped(user, id);
      if (expense.status !== "APPROVED") {
        throw new ConflictException(
          `Only an APPROVED claim can be marked reimbursed — this one is ${expense.status}.`,
        );
      }
      const updated = await tx.expense.updateMany({
        where: { id, status: "APPROVED" },
        data: { status: "REIMBURSED", reimbursedAt: new Date() },
      });
      if (updated.count === 0) throw new ConflictException("This claim's status changed a moment ago.");

      await tx.auditLog.create({
        data: {
          workspaceId: user.workspaceId,
          actorId: user.id,
          action: "expense.reimbursed",
          entityType: "expense",
          entityId: id,
          before: { status: "APPROVED" },
          after: { status: "REIMBURSED", amount: Number(expense.amount), claimantId: expense.userId },
        },
      });
      return tx.expense.findUniqueOrThrow({ where: { id }, include: { user: { select: { id: true, name: true } } } });
    });
  }

  /**
   * Withdraws a claim. The claimant may only withdraw their own, and only
   * while it is still PENDING — once money has been authorised, the record
   * stays.
   */
  async withdraw(user: RequestUser, id: string) {
    const expense = await this.loadScoped(user, id);
    if (expense.userId !== user.id) throw new ForbiddenException("You can only withdraw your own claim.");
    if (expense.status !== "PENDING") {
      throw new ConflictException(`Only a PENDING claim can be withdrawn — this one is ${expense.status}.`);
    }
    return this.prisma.client.expense.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
