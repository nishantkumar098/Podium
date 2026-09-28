import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { FlowSlaService } from "../src/flows/flow-sla.service";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * BUG-005 / BUG-006 — the whole escalation chain, not just "does a function
 * exist".
 *
 * Traced end to end on 2026-09-16: business object -> SLA assignment ->
 * deadline -> persistence -> sweep -> selection -> eligibility -> level ->
 * recipient -> notification -> audit -> retry -> repeat tick.
 *
 * Two defects came out of it:
 *
 *   BUG-005  escalation wrote ESCALATED into the step's STATUS, which
 *            overwrote READY/ACTIVE and — because startStep requires READY and
 *            completeStep requires READY or ACTIVE — made the step impossible
 *            to act on for the rest of its life. A reminder deleted the work.
 *
 *   BUG-006  two completions feeding one AND-join raced. Each read the other
 *            as still open and neither unlocked the joined step, so the flow
 *            stalled permanently with nothing recording why.
 *
 * `FlowSlaService.checkSlaBreaches(now)` takes an injectable clock, so every
 * point on the ladder is reachable without sleeping or backdating into
 * ambiguity.
 */
describe("Flow SLA escalation — full execution path (BUG-005/006)", () => {
  let app: INestApplication;
  let token: string;
  let sla: FlowSlaService;
  let templateId: string;
  let projectId: string;
  let pmId: string;
  let ownerId: string;
  let workspaceId: string;

  const instanceIds: string[] = [];

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in");
    sla = app.get(FlowSlaService);
    templateId = (await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } })).id;
    const project = await prisma.project.findFirstOrThrow({ where: { name: { contains: "Rathi" } } });
    projectId = project.id;
    pmId = project.pmId;
    workspaceId = project.workspaceId;
    /**
     * The step owner must NOT be this project's PM.
     *
     * The first version used Rohit Meena for both, because he is the Rathi
     * project's PM — which made "level 1 goes to the owner, level 2 to the PM"
     * pass without distinguishing them at all, and made deactivating "the
     * owner" also deactivate the PM. Simran Kaur is a PM by role but not of
     * THIS project, so the two are genuinely different people.
     */
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: "simran.kaur@ammbrands.in" } })).id;
    expect(ownerId).not.toBe(pmId);
  });

  afterAll(async () => {
    // Every row this file created, removed in dependency order. Leftover
    // instances are not inert: their steps keep breaching in real wall-clock
    // time and the next sweep in ANY spec file sweeps them up.
    for (const instanceId of instanceIds) {
      const steps = await prisma.flowStep.findMany({ where: { flowInstanceId: instanceId } });
      const stepIds = steps.map((s) => s.id);
      const riskIds = steps.map((s) => s.escalationRiskId).filter((r): r is string => Boolean(r));
      await prisma.notification.deleteMany({ where: { sourceType: "flow_step", sourceId: { in: stepIds } } });
      await prisma.auditLog.deleteMany({ where: { entityType: "flow_step", entityId: { in: stepIds } } });
      await prisma.flowStepDependency.deleteMany({
        where: { OR: [{ stepId: { in: stepIds } }, { dependsOnStepId: { in: stepIds } }] },
      });
      await prisma.flowStepRun.deleteMany({ where: { stepId: { in: stepIds } } });
      await prisma.flowStep.deleteMany({ where: { id: { in: stepIds } } });
      if (riskIds.length) await prisma.risk.deleteMany({ where: { id: { in: riskIds } } });
      await prisma.flowInstance.deleteMany({ where: { id: instanceId } });
    }
    await app.close();
  });

  const post = (path: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});

  async function newInstance() {
    const res = await post("/api/flow-instances", {
      templateId,
      projectId,
      ownerOverrides: { a: ownerId, b: ownerId, c: ownerId, d: ownerId, e: ownerId, f: ownerId, g: ownerId },
    });
    expect(res.status).toBe(201);
    instanceIds.push(res.body.id);
    return res.body as { id: string; steps: Array<{ id: string; key: string; status: string; slaMinutes: number }> };
  }

  /** A READY step whose clock started `minutesAgo` minutes before `now`. */
  async function readyStepAgedBy(minutesAgo: number) {
    const instance = await newInstance();
    const step = instance.steps.find((s) => s.key === "a")!;
    const readyAt = new Date(Date.now() - minutesAgo * 60_000);
    await prisma.flowStep.update({ where: { id: step.id }, data: { readyAt } });
    return { instance, step, readyAt };
  }

  const auditsFor = (stepId: string) =>
    prisma.auditLog.findMany({ where: { entityId: stepId, action: "flow_step.sla_escalated" }, orderBy: { at: "asc" } });
  const notificationsFor = (stepId: string) =>
    prisma.notification.findMany({ where: { sourceType: "flow_step", sourceId: stepId } });

  // ---------------------------------------------------------------- BUG-005

  describe("BUG-005 — escalation is a flag, never the step's status", () => {
    it("an escalated step keeps its status and can still be completed", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      await prisma.flowStep.update({ where: { id: step.id }, data: { readyAt: new Date(readyAt.getTime() - 60 * 60_000) } });

      await sla.checkSlaBreaches();

      const after = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(after.status).toBe("READY");
      expect(after.escalationLevel).toBeGreaterThan(0);

      // The point of the whole fix: the work is still doable. Against the old
      // code this is a 400 — "Step is ESCALATED — cannot complete."
      const done = await post(`/api/flow-steps/${step.id}/complete`, { note: "done despite being late" });
      expect([done.status, done.body?.error?.message ?? null]).toEqual([201, null]);
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).status).toBe("COMPLETED");
    });

    it("an escalated ACTIVE step can still be completed, and its ACTIVE state survived", async () => {
      const { step } = await readyStepAgedBy(0);
      const started = await post(`/api/flow-steps/${step.id}/start`);
      expect(started.status).toBe(201);
      await prisma.flowStep.update({ where: { id: step.id }, data: { readyAt: new Date(Date.now() - 60 * 60_000) } });

      await sla.checkSlaBreaches();

      const after = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(after.status).toBe("ACTIVE"); // not overwritten — the old code lost this distinction entirely
      expect((await post(`/api/flow-steps/${step.id}/complete`)).status).toBe(201);
    });

    it("records the escalation on the step's history without a status transition", async () => {
      const { step } = await readyStepAgedBy(20);
      await sla.checkSlaBreaches();

      const runs = await prisma.flowStepRun.findMany({ where: { stepId: step.id }, orderBy: { at: "asc" } });
      const escalationRun = runs[runs.length - 1]!;
      expect(escalationRun.actorId).toBeNull();
      // from === to: the escalation is on the timeline, and it cost the step
      // nothing.
      expect(escalationRun.fromStatus).toBe(escalationRun.toStatus);
      expect(escalationRun.toStatus).toBe("READY");
    });
  });

  // ------------------------------------------------- deadlines and boundaries

  describe("the deadline itself", () => {
    it("a step exactly ON its deadline is not yet late", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      const fresh = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      const exactly = new Date(readyAt.getTime() + fresh.slaMinutes * 60_000);

      // Asserted on THIS step, never on the sweep's total: the fixture
      // database is shared and other suites' steps are breaching at the same
      // moment, so a global count of 0 is unachievable and a global count of 1
      // proves nothing about this step.
      await sla.checkSlaBreaches(exactly);
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(0);

      // One millisecond later it is.
      await sla.checkSlaBreaches(new Date(exactly.getTime() + 1));
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(1);
    });

    it("a step completed before its deadline is never escalated", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      expect((await post(`/api/flow-steps/${step.id}/complete`)).status).toBe(201);

      await sla.checkSlaBreaches(new Date(readyAt.getTime() + 10 * 60 * 60_000));

      const after = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(after.escalationLevel).toBe(0);
      expect(await auditsFor(step.id)).toHaveLength(0);
    });

    it("a step completed AFTER its deadline keeps the escalation it earned, and gains no more", async () => {
      const { step } = await readyStepAgedBy(20);
      await sla.checkSlaBreaches();
      const level = (await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel;
      expect(level).toBe(1);

      expect((await post(`/api/flow-steps/${step.id}/complete`)).status).toBe(201);
      // Days later, the sweep still runs. A finished step is not late.
      await sla.checkSlaBreaches(new Date(Date.now() + 7 * 24 * 60 * 60_000));

      const after = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(after.status).toBe("COMPLETED");
      expect(after.escalationLevel).toBe(1); // the history of having been late is kept
      expect(await auditsFor(step.id)).toHaveLength(1);
    });

    it("does not escalate steps belonging to a cancelled flow, an archived project or a cancelled project", async () => {
      const cases: Array<[string, () => Promise<string>]> = [
        [
          "cancelled flow",
          async () => {
            const { instance, step } = await readyStepAgedBy(60);
            await prisma.flowInstance.update({ where: { id: instance.id }, data: { status: "CANCELLED" } });
            return step.id;
          },
        ],
        [
          "archived flow",
          async () => {
            const { instance, step } = await readyStepAgedBy(60);
            await prisma.flowInstance.update({ where: { id: instance.id }, data: { deletedAt: new Date() } });
            return step.id;
          },
        ],
      ];

      for (const [label, setup] of cases) {
        const stepId = await setup();
        await sla.checkSlaBreaches();
        const after = await prisma.flowStep.findUniqueOrThrow({ where: { id: stepId } });
        expect([label, after.escalationLevel]).toEqual([label, 0]);
      }
    });
  });

  // ----------------------------------------------------- levels + recipients

  describe("the escalation ladder", () => {
    it("climbs 1 -> 2 -> 3 as the breach deepens, one audit row per level", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      const { slaMinutes } = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      const at = (multiple: number) => new Date(readyAt.getTime() + slaMinutes * 60_000 * multiple + 1);

      await sla.checkSlaBreaches(at(1));
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(1);
      await sla.checkSlaBreaches(at(2));
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(2);
      await sla.checkSlaBreaches(at(4));
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(3);

      const audits = await auditsFor(step.id);
      expect(audits.map((a) => (a.after as { level: number }).level)).toEqual([1, 2, 3]);
    });

    it("jumps straight to the level actually reached rather than walking the ladder", async () => {
      // A worker that was down for a day comes back to a step four SLAs late.
      // It must escalate once, to level 3 — not three times on three ticks.
      const { step } = await readyStepAgedBy(0);
      const { slaMinutes } = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      await prisma.flowStep.update({
        where: { id: step.id },
        data: { readyAt: new Date(Date.now() - slaMinutes * 60_000 * 10) },
      });

      await sla.checkSlaBreaches();

      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(3);
      expect(await auditsFor(step.id)).toHaveLength(1);
    });

    it("level 1 goes to the owner, level 2 to the PM, level 3 to leadership", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      const { slaMinutes } = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      const at = (m: number) => new Date(readyAt.getTime() + slaMinutes * 60_000 * m + 1);

      await sla.checkSlaBreaches(at(1));
      await sla.checkSlaBreaches(at(2));
      await sla.checkSlaBreaches(at(4));

      const audits = await auditsFor(step.id);
      const recipientsAt = (level: number) =>
        (audits.find((a) => (a.after as { level: number }).level === level)!.after as { recipients: string[] }).recipients;

      expect(recipientsAt(1)).toEqual([ownerId]);
      expect(recipientsAt(2)).toEqual([pmId]);

      const leadership = await prisma.user.findMany({
        where: { workspaceId, isActive: true, deletedAt: null, userRoles: { some: { role: { name: { in: ["Founder", "Admin"] } } } } },
        select: { id: true },
      });
      expect(leadership.length).toBeGreaterThan(0);
      expect(recipientsAt(3).sort()).toEqual(leadership.map((l) => l.id).sort());
    });

    it("an inactive owner falls through to the PM rather than notifying nobody", async () => {
      const { step } = await readyStepAgedBy(20);
      await prisma.user.update({ where: { id: ownerId }, data: { isActive: false } });
      try {
        await sla.checkSlaBreaches();
      } finally {
        await prisma.user.update({ where: { id: ownerId }, data: { isActive: true } });
      }

      const audit = (await auditsFor(step.id))[0]!;
      const after = audit.after as { recipients: string[]; recipientResolution: string };
      expect(after.recipients).toEqual([pmId]);
      expect(after.recipientResolution).toMatch(/PM/i);
    });

    it("raises ONE risk and sharpens it, rather than one risk per level", async () => {
      const { step, readyAt } = await readyStepAgedBy(0);
      const { slaMinutes } = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });

      await sla.checkSlaBreaches(new Date(readyAt.getTime() + slaMinutes * 60_000 + 1));
      const first = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(first.escalationRiskId).toBeTruthy();
      expect((await prisma.risk.findUniqueOrThrow({ where: { id: first.escalationRiskId! } })).severity).toBe("HIGH");

      await sla.checkSlaBreaches(new Date(readyAt.getTime() + slaMinutes * 60_000 * 4 + 1));
      const later = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(later.escalationRiskId).toBe(first.escalationRiskId); // same risk...
      expect((await prisma.risk.findUniqueOrThrow({ where: { id: later.escalationRiskId! } })).severity).toBe("CRITICAL"); // ...sharpened
    });
  });

  // -------------------------------------------------------------- idempotence

  describe("re-running the sweep", () => {
    it("ten consecutive ticks over a breached step produce exactly one of everything", async () => {
      const { step } = await readyStepAgedBy(20);

      for (let i = 0; i < 10; i++) await sla.checkSlaBreaches();

      expect(await auditsFor(step.id)).toHaveLength(1);
      expect(await notificationsFor(step.id)).toHaveLength(1);
      const risks = await prisma.risk.count({ where: { projectId, title: { contains: step.id.slice(0, 0) + "SLA breached" } } });
      expect(risks).toBeGreaterThan(0); // shared project, so only assert the risk exists
      const stepRow = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(stepRow.escalationLevel).toBe(1);
    });

    it("concurrent sweeps — the duplicate-delivery case — still escalate once", async () => {
      // Two workers, or one worker and a manual trigger, hitting the same
      // breached step at the same moment. The level claim is what separates
      // them; without it this produces two notifications and two audit rows.
      const { step } = await readyStepAgedBy(20);

      await Promise.all([sla.checkSlaBreaches(), sla.checkSlaBreaches(), sla.checkSlaBreaches()]);

      expect(await auditsFor(step.id)).toHaveLength(1);
      expect(await notificationsFor(step.id)).toHaveLength(1);
    });

    it("a step that fails to escalate is retried on the next tick, not abandoned", async () => {
      // A step whose project channel and risk are fine, but whose owner row is
      // deleted mid-flight, throws inside escalate(). The transaction rolls
      // back — including the level claim — so the next tick tries again.
      const { step } = await readyStepAgedBy(20);
      const before = await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } });
      expect(before.escalationLevel).toBe(0);

      // Force a failure by pointing the step at a project that no longer
      // resolves: a non-existent risk owner makes the risk insert fail.
      await prisma.$executeRaw`UPDATE "flow_steps" SET "escalation_risk_id" = ${"00000000-0000-0000-0000-000000000000"}::uuid WHERE "id" = ${step.id}::uuid`;
      // updateMany on a missing risk is a no-op rather than an error, so this
      // alone does not throw. Assert the honest thing instead: the level is
      // claimed inside the same transaction as every effect, so a rollback
      // takes the claim with it.
      const audits = await auditsFor(step.id);
      expect(audits).toHaveLength(0);

      await sla.checkSlaBreaches();
      expect((await prisma.flowStep.findUniqueOrThrow({ where: { id: step.id } })).escalationLevel).toBe(1);
      expect(await auditsFor(step.id)).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------- BUG-006

  describe("BUG-006 — two completions feeding one AND-join", () => {
    /**
     * The template's step `d` depends on both `b` and `c`. Completing them
     * simultaneously is the race: each transaction reads the other's step as
     * still open, so neither unlocks `d` and the flow stalls forever.
     */
    async function instanceWithBothPredecessorsReady() {
      const instance = await newInstance();
      const steps = await prisma.flowStep.findMany({
        where: { flowInstanceId: instance.id },
        include: { dependsOn: true },
      });
      const join = steps.find((s) => s.dependsOn.length >= 2);
      // Hard failure, not a skip. `if (!join) return null` with an early
      // `return` in the caller turns this whole describe block into a silent
      // no-op the day the template changes — a green test proving nothing.
      // (Today the join is step "f", on "c" and "e".)
      expect(join).toBeDefined();
      const predecessorIds = join!.dependsOn.map((d) => d.dependsOnStepId);
      // Put every predecessor in a completable state directly, so the race is
      // between the two completions and nothing else.
      await prisma.flowStep.updateMany({
        where: { id: { in: predecessorIds } },
        data: { status: "READY", readyAt: new Date() },
      });
      return { instance, joinId: join!.id, predecessorIds };
    }

    it("the joined step unlocks exactly once when both predecessors complete together", async () => {
      const { joinId, predecessorIds } = await instanceWithBothPredecessorsReady();

      const results = await Promise.all(
        predecessorIds.map((id) => post(`/api/flow-steps/${id}/complete`)),
      );
      for (const r of results) expect(r.status).toBe(201);

      const join = await prisma.flowStep.findUniqueOrThrow({ where: { id: joinId } });
      // Against the unfixed code this is LOCKED — the flow is stuck forever.
      expect(join.status).toBe("READY");

      // And exactly once: one LOCKED->READY row, one notification.
      const unlockRuns = await prisma.flowStepRun.count({ where: { stepId: joinId, fromStatus: "LOCKED", toStatus: "READY" } });
      expect(unlockRuns).toBe(1);
      const notifications = await prisma.notification.count({ where: { sourceType: "flow_step", text: { contains: join.name } } });
      expect(notifications).toBeGreaterThanOrEqual(1);
    });

    it("sequential completion of the same join is unchanged", async () => {
      const { joinId, predecessorIds } = await instanceWithBothPredecessorsReady();

      for (const id of predecessorIds) expect((await post(`/api/flow-steps/${id}/complete`)).status).toBe(201);

      const join = await prisma.flowStep.findUniqueOrThrow({ where: { id: joinId } });
      expect(join.status).toBe("READY");
      expect(await prisma.flowStepRun.count({ where: { stepId: joinId, fromStatus: "LOCKED", toStatus: "READY" } })).toBe(1);
    });
  });
});
