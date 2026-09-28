import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * SLA breach -> escalation (blueprint §6). This was the single largest
 * "looks live, isn't" gap a 2026-09-11 production-readiness audit found:
 * `slaMinutes`, `readyAt`, and the `ESCALATED` enum value all existed and
 * were seeded, but nothing ever read them. FlowSlaService closes that gap
 * with a one-minute sweep; this test drives the same code path via its
 * manual-trigger endpoint (POST /flows/sla-check) so it doesn't have to wait
 * on real wall-clock time.
 *
 * CONTRACT CHANGE, 2026-09-16 (BUG-005). Three assertions in this file used
 * to require `status === "ESCALATED"` — they were encoding the bug. Setting
 * the step's STATUS to ESCALATED overwrote READY/ACTIVE and made the step
 * permanently impossible to start or complete, because startStep requires
 * READY and completeStep requires READY or ACTIVE. Escalation is now a flag
 * (`escalatedAt`, `escalationLevel`) and the status is left alone, so those
 * assertions are inverted here: the test now proves the status did NOT
 * change. The deeper coverage of the whole chain lives in
 * flow-sla-escalation.e2e-spec.ts.
 */
describe("Flow SLA escalation (e2e)", () => {
  let app: INestApplication;
  let founderToken: string;
  let founderId: string;
  let templateId: string;
  let projectId: string;
  let pmId: string;
  // Re-runnability (Phase B.1): every test below creates a real flow
  // instance against the shared "Rathi" project and never had a way to
  // clean it up. slaMinutes on these steps is small (15 minutes), so a
  // leftover instance from an earlier run — even much earlier the same day
  // — has usually already bred past its own SLA in real wall-clock time by
  // the time this file runs again. The NEXT sla-check call (in this file or
  // any other) then sweeps it up too, raising an extra risk on the same
  // project and inflating any count keyed off `projectId` rather than a
  // specific step. Tracking every created instance here and deleting it in
  // afterAll removes the leftover entirely, rather than working around it.
  const createdInstanceIds: string[] = [];

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founderToken = await loginAs(app, "anant.sharma@ammbrands.in");
    const founder = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
    founderId = founder.id;
    const template = await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } });
    templateId = template.id;
    const project = await prisma.project.findFirstOrThrow({ where: { name: { contains: "Rathi" } } });
    projectId = project.id;
    pmId = project.pmId;
  });

  afterAll(async () => {
    if (createdInstanceIds.length > 0) {
      const steps = await prisma.flowStep.findMany({ where: { flowInstanceId: { in: createdInstanceIds } } });
      const stepIds = steps.map((s) => s.id);
      if (stepIds.length > 0) {
        const escalationAudits = await prisma.auditLog.findMany({
          where: { entityType: "flow_step", entityId: { in: stepIds }, action: "flow_step.sla_escalated" },
        });
        const raisedRiskIds = escalationAudits
          .map((a) => (a.after as { raisedRiskId?: string } | null)?.raisedRiskId)
          .filter((id): id is string => Boolean(id));
        if (raisedRiskIds.length > 0) await prisma.risk.deleteMany({ where: { id: { in: raisedRiskIds } } });
        await prisma.notification.deleteMany({ where: { sourceType: "flow_step", sourceId: { in: stepIds } } });
        await prisma.auditLog.deleteMany({ where: { entityType: "flow_step", entityId: { in: stepIds } } });
        await prisma.flowStepDependency.deleteMany({
          where: { OR: [{ stepId: { in: stepIds } }, { dependsOnStepId: { in: stepIds } }] },
        });
        await prisma.flowStepRun.deleteMany({ where: { stepId: { in: stepIds } } });
        await prisma.flowStep.deleteMany({ where: { id: { in: stepIds } } });
      }
      await prisma.flowInstance.deleteMany({ where: { id: { in: createdInstanceIds } } });
    }
    await app.close();
  });

  function post(path: string, body?: unknown) {
    return request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${founderToken}`).send(body ?? {});
  }
  function get(path: string) {
    return request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${founderToken}`);
  }
  async function createInstance() {
    const instance = (
      await post("/api/flow-instances", {
        templateId,
        projectId,
        ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
      })
    ).body;
    createdInstanceIds.push(instance.id);
    return instance;
  }

  it("escalates a breached step — a raised risk, a notification, an audit row — WITHOUT changing its status", async () => {
    const instance = await createInstance();
    const stepA = instance.steps.find((s: { key: string }) => s.key === "a");
    expect(stepA.status).toBe("READY");

    // 20 minutes against a 15-minute SLA: past level 1, short of level 2
    // (which is at 2x SLA = 30 minutes). Backdating an hour, as this used to,
    // lands on level 3 and changes both the severity and the recipient.
    await prisma.flowStep.update({ where: { id: stepA.id }, data: { readyAt: new Date(Date.now() - 20 * 60_000) } });

    const check = await post("/api/flows/sla-check");
    expect(check.status).toBe(201);
    expect(check.body.escalated).toBeGreaterThanOrEqual(1);

    const fresh = (await get(`/api/flow-instances/${instance.id}`)).body;
    const afterSweep = fresh.steps.find((s: { key: string }) => s.key === "a");
    // BUG-005: the step is flagged, not re-statused. It is still READY, so
    // the person it belongs to can still start and finish it.
    expect(afterSweep.status).toBe("READY");

    const flagged = await prisma.flowStep.findUniqueOrThrow({ where: { id: stepA.id } });
    expect(flagged.escalationLevel).toBeGreaterThanOrEqual(1);
    expect(flagged.escalatedAt).not.toBeNull();

    const run = await prisma.flowStepRun.findFirst({ where: { stepId: stepA.id }, orderBy: { at: "desc" } });
    expect(run).not.toBeNull();
    expect(run!.actorId).toBeNull(); // system-initiated, not a human action

    // Scoped to the specific risk THIS step raised (via the audit row's
    // after.raisedRiskId), not a before/after count of every risk on the
    // shared "Rathi" project — a count delta is vulnerable to any other
    // risk-raising activity on that same project, including a leftover
    // flow instance from an earlier run breaching its own SLA the moment
    // any sla-check call sweeps it up.
    const audit = await prisma.auditLog.findFirst({ where: { entityId: stepA.id, action: "flow_step.sla_escalated" } });
    expect(audit).not.toBeNull();
    const raisedRiskId = (audit!.after as { raisedRiskId?: string } | null)?.raisedRiskId;
    expect(raisedRiskId).toBeTruthy();
    const raisedRisk = await prisma.risk.findUnique({ where: { id: raisedRiskId! } });
    expect(raisedRisk).not.toBeNull();
    expect(raisedRisk!.projectId).toBe(projectId);
    expect(raisedRisk!.severity).toBe("HIGH");
    expect(raisedRisk!.status).toBe("OPEN");

    // Level 1 goes to the person actually holding the step, not the PM — it
    // is their work that is late. (Here they are the same person, so assert
    // on the owner explicitly rather than let that coincidence hide it.)
    const owner = await prisma.flowStep.findUniqueOrThrow({ where: { id: stepA.id } });
    const notified = await prisma.notification.findFirst({
      where: { userId: owner.ownerId, sourceType: "flow_step", sourceId: stepA.id },
    });
    expect(notified).not.toBeNull();
    expect(pmId).toBeTruthy(); // the PM is the level-2 recipient, covered in flow-sla-escalation.e2e-spec.ts
  });

  it("is idempotent — re-running the check does not escalate the same step to the same level twice", async () => {
    const instance = await createInstance();
    const stepA = instance.steps.find((s: { key: string }) => s.key === "a");
    // 60 minutes past a 15-minute SLA is level 1 only (level 2 is at 30
    // minutes... which 60 also passes). Place it at 20 minutes so exactly one
    // rung has been passed and a repeat sweep has nothing further to do.
    await prisma.flowStep.update({ where: { id: stepA.id }, data: { readyAt: new Date(Date.now() - 20 * 60_000) } });

    await post("/api/flows/sla-check");
    const afterFirst = await prisma.auditLog.count({ where: { entityId: stepA.id, action: "flow_step.sla_escalated" } });
    await post("/api/flows/sla-check");
    const afterSecond = await prisma.auditLog.count({ where: { entityId: stepA.id, action: "flow_step.sla_escalated" } });

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // not 2 — the level was already claimed
  });

  it("leaves a step that has NOT breached its SLA untouched", async () => {
    const instance = await createInstance();
    // step a is READY but freshly created -- well within its 15-minute SLA
    await post("/api/flows/sla-check");
    const fresh = (await get(`/api/flow-instances/${instance.id}`)).body;
    expect(fresh.steps.find((s: { key: string }) => s.key === "a").status).toBe("READY");
  });

  it("rejects the manual trigger for a role without automation:edit (e.g. Sales)", async () => {
    const salesToken = await loginAs(app, "ananya.joshi@ammbrands.in");
    const res = await request(app.getHttpServer()).post("/api/flows/sla-check").set("Authorization", `Bearer ${salesToken}`).send({});
    expect(res.status).toBe(403);
  });
});
