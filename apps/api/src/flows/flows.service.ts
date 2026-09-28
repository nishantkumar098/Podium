import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PrismaClient } from "@podium/db";
import type { InstantiateFlowInput } from "@podium/shared-types";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { SAFE_USER_SELECT } from "../common/safe-user";
import type { RequestUser } from "../common/types";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

interface TemplateStep {
  k: string;
  name: string;
  role: string;
  owner: string; // legacy prototype user key — only meaningful at seed time; runtime uses ownerOverrides / template default
  ownerId?: string;
  sla: number;
  deps: string[];
}

/**
 * The flow engine: a real server-authoritative state machine (blueprint §6),
 * not a checklist. This is the platform's actual differentiator, so every
 * transition here is transactional, writes an immutable flow_step_runs row,
 * and fans out notifications + a project-channel "Podium Bot" message on
 * unlock — mirroring the prototype's instantiateFlow/startStep/completeStep
 * exactly, but with real authorization and atomicity instead of array
 * mutation in the browser.
 */
@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
  ) {}

  listTemplates(user: RequestUser) {
    return this.prisma.client.flowTemplate.findMany({ where: { workspaceId: user.workspaceId, deletedAt: null } });
  }

  async listInstances(user: RequestUser, projectId?: string) {
    const scope = this.cityScope.scopeFilter(user);
    return this.prisma.client.flowInstance.findMany({
      where: {
        deletedAt: null,
        ...(projectId ? { projectId } : {}),
        project: { workspaceId: user.workspaceId, ...scope },
      },
      include: { steps: { include: { dependsOn: true } }, template: true, project: { select: { id: true, name: true, cityId: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getInstance(user: RequestUser, id: string) {
    const instance = await this.prisma.client.flowInstance.findFirst({
      where: { id, deletedAt: null },
      include: { steps: { include: { dependsOn: true, owner: { select: SAFE_USER_SELECT } } }, template: true, project: true },
    });
    if (!instance) throw new NotFoundException("Flow not found.");
    this.cityScope.assertCanAccessCity(user, instance.project.cityId);
    return instance;
  }

  /** My queue: steps ready or active for this user, across every flow — the "baton" view (blueprint §5B). */
  async myQueue(user: RequestUser) {
    return this.prisma.client.flowStep.findMany({
      where: { ownerId: user.id, status: { in: ["READY", "ACTIVE"] }, deletedAt: null },
      include: { flowInstance: { include: { project: { select: { id: true, name: true } } } } },
      orderBy: { readyAt: "asc" },
    });
  }

  async instantiate(user: RequestUser, input: InstantiateFlowInput) {
    const [template, project] = await Promise.all([
      this.prisma.client.flowTemplate.findFirst({ where: { id: input.templateId, workspaceId: user.workspaceId } }),
      this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } }),
    ]);
    if (!template) throw new NotFoundException("Flow template not found.");
    if (!project) throw new NotFoundException("Project not found.");
    this.cityScope.assertCanAccessCity(user, project.cityId);

    const steps = template.steps as unknown as TemplateStep[];
    const overrides = input.ownerOverrides ?? {};
    for (const s of steps) {
      if (!overrides[s.k] && !s.ownerId) {
        throw new BadRequestException(`No owner specified for step "${s.k}" — pass ownerOverrides.${s.k} (the template's seed owner keys are not real user ids).`);
      }
    }

    return this.prisma.client.$transaction(async (tx) => {
      const instance = await tx.flowInstance.create({
        data: {
          templateId: template.id,
          projectId: project.id,
          name: input.name ?? template.name,
          status: "ACTIVE",
          createdById: user.id,
        },
      });

      const stepIdByKey: Record<string, string> = {};
      for (const s of steps) {
        const ownerId = overrides[s.k] ?? s.ownerId!;
        const isReady = s.deps.length === 0;
        const created = await tx.flowStep.create({
          data: {
            flowInstanceId: instance.id,
            key: s.k,
            name: s.name,
            role: s.role,
            ownerId,
            slaMinutes: s.sla,
            status: isReady ? "READY" : "LOCKED",
            readyAt: isReady ? new Date() : null,
          },
        });
        stepIdByKey[s.k] = created.id;
      }
      for (const s of steps) {
        for (const depKey of s.deps) {
          await tx.flowStepDependency.create({
            data: { stepId: stepIdByKey[s.k], dependsOnStepId: stepIdByKey[depKey], joinType: "AND" },
          });
        }
      }
      return tx.flowInstance.findUniqueOrThrow({ where: { id: instance.id }, include: { steps: true } });
    });
  }

  async startStep(user: RequestUser, stepId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const step = await this.loadStepForAction(tx, user, stepId);
      if (step.status !== "READY") {
        throw new BadRequestException(`Step is ${step.status}, not READY — cannot start.`);
      }
      const updated = await tx.flowStep.update({ where: { id: step.id }, data: { status: "ACTIVE", startedAt: new Date() } });
      await tx.flowStepRun.create({ data: { stepId: step.id, fromStatus: "READY", toStatus: "ACTIVE", actorId: user.id } });
      return updated;
    });
  }

  async reassignStep(user: RequestUser, stepId: string, newOwnerId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const step = await this.loadStepForAction(tx, user, stepId, { requireManagerOverride: true });

      // Reassigning to someone with no access to this project's city would
      // silently create an unreachable step: the new "owner" would be
      // city-scope-blocked from ever starting/completing it themselves,
      // recoverable only by a manager-override action. Caught by this
      // session's own RBAC/flow-engine audit (reassigning a Udaipur-project
      // step to a Jaipur-only Operations user produced exactly that stuck
      // state) — reject it up front instead.
      const newOwnerAccess = await tx.userCityAccess.findMany({ where: { userId: newOwnerId } });
      const hasAccess = newOwnerAccess.some((g) => g.scope === "ALL" || g.cityId === step.flowInstance.project.cityId);
      if (!hasAccess) {
        throw new BadRequestException("The new owner does not have access to this project's city — reassignment would leave the step unreachable to them.");
      }

      const updated = await tx.flowStep.update({ where: { id: step.id }, data: { ownerId: newOwnerId } });
      if (step.status === "READY" || step.status === "ACTIVE") {
        await this.notifyAndBotDm(tx, step.flowInstance.project.workspaceId, newOwnerId, "⇢", `${user.name} assigned you "${step.name}" in ${step.flowInstance.name}. It's ready now.`, step.flowInstance.projectId);
      }
      return updated;
    });
  }

  /**
   * The handoff itself: mirrors the prototype's completeStep exactly — mark
   * done, re-evaluate every LOCKED step in the instance, flip any whose
   * AND-join is now fully satisfied to READY, notify the new owner in-app
   * and via a "Podium Bot" project-channel message, and write the
   * flow_step_runs audit row for every transition this call causes.
   */
  async completeStep(user: RequestUser, stepId: string, note?: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const step = await this.loadStepForAction(tx, user, stepId);
      if (step.status !== "READY" && step.status !== "ACTIVE") {
        throw new BadRequestException(`Step is ${step.status} — cannot complete.`);
      }

      /**
       * BUG-006. Lock every step of this flow instance before touching any of
       * them, so two completions in the same flow are serialised.
       *
       * Without it, an AND-join silently breaks. Steps B and C both feed D.
       * Alice completes B while Bob completes C. At READ COMMITTED each
       * transaction reads the other's step as still open — each snapshot was
       * taken before the other committed — so each concludes D's dependencies
       * are unmet and neither unlocks it. **D never becomes READY and the flow
       * stalls forever**, with nothing anywhere recording that it happened.
       *
       * The mirror-image interleaving is no better: if both DO see each other
       * as complete, both unlock D, and D gets two READY transitions, two
       * flow_step_runs rows, two notifications and two bot messages.
       *
       * Ordering by id makes the lock order deterministic, so two completions
       * in the same instance can never deadlock against each other.
       */
      await tx.$queryRaw`
        SELECT "id" FROM "flow_steps"
         WHERE "flow_instance_id" = ${step.flowInstanceId}::uuid
           AND "deleted_at" IS NULL
         ORDER BY "id"
           FOR UPDATE`;
      const now = new Date();
      await tx.flowStep.update({
        where: { id: step.id },
        data: { status: "COMPLETED", doneAt: now, startedAt: step.startedAt ?? now, note: note ?? step.note },
      });
      await tx.flowStepRun.create({ data: { stepId: step.id, fromStatus: step.status, toStatus: "COMPLETED", actorId: user.id } });

      const allSteps = await tx.flowStep.findMany({
        where: { flowInstanceId: step.flowInstanceId, deletedAt: null },
        include: { dependsOn: true },
      });
      const statusByStepId = new Map(allSteps.map((s) => [s.id, s.id === step.id ? "COMPLETED" : s.status]));

      const unlocked: typeof allSteps = [];
      for (const candidate of allSteps) {
        if (candidate.id === step.id || candidate.status !== "LOCKED") continue;
        const depsMet = candidate.dependsOn.every((d) => statusByStepId.get(d.dependsOnStepId) === "COMPLETED");
        if (depsMet) unlocked.push(candidate);
      }

      for (const n of unlocked) {
        /**
         * Guarded on LOCKED, and the guard is load-bearing rather than
         * decorative: it is the second half of the BUG-006 fix. The lock above
         * serialises completions within one instance, and this makes the
         * unlock itself conditional, so anything that still managed to arrive
         * twice — a retry, a future code path, a step unlocked by a different
         * transaction — writes once. A count of 0 means somebody else already
         * unlocked this step, and the notification must not be sent again.
         */
        const unlockedNow = await tx.flowStep.updateMany({
          where: { id: n.id, status: "LOCKED" },
          data: { status: "READY", readyAt: now },
        });
        if (unlockedNow.count === 0) continue;

        await tx.flowStepRun.create({ data: { stepId: n.id, fromStatus: "LOCKED", toStatus: "READY", actorId: null } });
        const text = `Your turn: "${n.name}" is ready — ${step.flowInstance.name}. ${step.name} is done.${note ? " Note: " + note : ""}`;
        await this.notifyAndBotDm(tx, step.flowInstance.project.workspaceId, n.ownerId, "⇢", text, step.flowInstance.projectId);
      }

      const stillOpen = allSteps.some((s) => s.id !== step.id && s.status !== "COMPLETED" && !unlocked.some((u) => u.id === s.id));
      if (!stillOpen && unlocked.length === 0) {
        await tx.flowInstance.update({ where: { id: step.flowInstanceId }, data: { status: "COMPLETED" } });
      }

      return tx.flowStep.findUniqueOrThrow({ where: { id: step.id } });
    });
  }

  /** Nudge: notify the owner their step has been waiting, no state change. */
  async nudgeStep(user: RequestUser, stepId: string) {
    const step = await this.prisma.client.flowStep.findFirst({ where: { id: stepId, deletedAt: null }, include: { flowInstance: true } });
    if (!step) throw new NotFoundException("Flow step not found.");
    const project = await this.prisma.client.project.findUniqueOrThrow({ where: { id: step.flowInstance.projectId } });
    this.cityScope.assertCanAccessCity(user, project.cityId);
    const waitedMins = step.readyAt ? Math.round((Date.now() - step.readyAt.getTime()) / 60000) : 0;
    await this.notifyAndBotDm(
      this.prisma.client,
      project.workspaceId,
      step.ownerId,
      "⏰",
      `${user.name} nudged you: "${step.name}" in ${step.flowInstance.name} has been waiting ${waitedMins}m.`,
      step.flowInstance.projectId,
    );
    return { ok: true };
  }

  private async loadStepForAction(
    tx: Tx,
    user: RequestUser,
    stepId: string,
    opts: { requireManagerOverride?: boolean } = {},
  ) {
    const step = await tx.flowStep.findFirst({ where: { id: stepId, deletedAt: null }, include: { flowInstance: { include: { project: true } } } });
    if (!step) throw new NotFoundException("Flow step not found.");
    this.cityScope.assertCanAccessCity(user, step.flowInstance.project.cityId);

    const isOwner = step.ownerId === user.id;
    const isManagerOverride = user.permissions.has("flows:edit");
    if (opts.requireManagerOverride) {
      if (!isManagerOverride) throw new ForbiddenException("Only a manager can reassign a flow step.");
    } else if (!isOwner && !isManagerOverride) {
      throw new ForbiddenException("Only the step's assigned owner (or a manager) can act on it.");
    }
    return step;
  }

  private async notifyAndBotDm(
    tx: Tx,
    workspaceId: string,
    userId: string,
    icon: string,
    text: string,
    projectId: string,
  ) {
    await tx.notification.create({ data: { workspaceId, userId, icon, text, sourceType: "flow_step" } });
    const channel = await tx.channel.findFirst({ where: { projectId, kind: "PROJECT" } });
    if (channel) {
      await tx.message.create({ data: { channelId: channel.id, authorId: null, body: `🤖 ${text}` } });
    }
  }
}
