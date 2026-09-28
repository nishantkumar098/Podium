import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase E: wiring a playbook's defaults into Deal-Won conversion (blueprint
 * §5A, automation au1). Converting a lead with a playbookId now actually
 * creates the playbook's tasks and instantiates its flow templates against
 * the new project — this used to be a documented gap (see the old comment
 * on LeadsService.convert(), "left to Phase 3's flow/task modules to wire").
 *
 * OPEN DECISION (see docs/STATUS.md Phase E report): every task/flow-step
 * this creates is owned by the converting PM, not routed by role — asserted
 * explicitly below so a future change to that default is a visible test
 * failure, not a silent behavior change.
 */
describe("Deal-Won -> playbook application (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let pmId: string;
  let cityId: string;
  let templateId: string;
  let templateStepKeys: string[];

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    const pm = await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } });
    pmId = pm.id;
    const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });
    cityId = jaipur.id;
    const template = await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } });
    templateId = template.id;
    templateStepKeys = (template.steps as unknown as Array<{ k: string }>).map((s) => s.k);
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});

  async function createLead(name: string) {
    const res = await post("/api/leads", founder, { name, value: 500_000, cityId, ownerId: pmId });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("converting with no playbookId creates no extra tasks or flows (unchanged behavior)", async () => {
    const leadId = await createLead("e2e wiring — no playbook");
    const res = await post(`/api/leads/${leadId}/convert`, founder, {
      projectName: "e2e wiring project — no playbook",
      projectType: "Corporate",
      eventDate: "2027-03-01",
      pmId,
      cityId,
      value: 500_000,
      clientName: "e2e wiring client A",
    });
    expect(res.status).toBe(201);
    const projectId = res.body.project.id;
    expect(await prisma.task.count({ where: { projectId } })).toBe(0);
    expect(await prisma.flowInstance.count({ where: { projectId } })).toBe(0);
  });

  it("converting with a playbookId creates its tasks (with due dates offset from the event date) and instantiates its flows", async () => {
    const playbook = await post("/api/playbooks", founder, {
      name: "e2e wiring playbook",
      eventType: "Corporate",
      defaultTasks: [
        { name: "e2e task — book venue", dueOffsetDays: 30 },
        { name: "e2e task — no due date" },
      ],
      defaultFlowTemplateIds: [templateId],
    });
    expect(playbook.status).toBe(201);

    const leadId = await createLead("e2e wiring — with playbook");
    const eventDate = "2027-06-15";
    const res = await post(`/api/leads/${leadId}/convert`, founder, {
      projectName: "e2e wiring project — with playbook",
      projectType: "Corporate",
      eventDate,
      pmId,
      cityId,
      value: 500_000,
      clientName: "e2e wiring client B",
      playbookId: playbook.body.id,
    });
    expect(res.status).toBe(201);
    const projectId = res.body.project.id;

    const tasks = await prisma.task.findMany({ where: { projectId } });
    expect(tasks).toHaveLength(2);
    const venueTask = tasks.find((t) => t.name === "e2e task — book venue")!;
    expect(venueTask.ownerId).toBe(pmId);
    const expectedDue = new Date(new Date(eventDate).getTime() - 30 * 86400000);
    expect(venueTask.dueAt?.toISOString().slice(0, 10)).toBe(expectedDue.toISOString().slice(0, 10));
    const noDueTask = tasks.find((t) => t.name === "e2e task — no due date")!;
    expect(noDueTask.dueAt).toBeNull();

    const instances = await prisma.flowInstance.findMany({ where: { projectId }, include: { steps: true } });
    expect(instances).toHaveLength(1);
    expect(instances[0].templateId).toBe(templateId);
    expect(instances[0].steps).toHaveLength(templateStepKeys.length);
    expect(instances[0].steps.every((s) => s.ownerId === pmId)).toBe(true);
  });

  it("a playbook with empty defaults converts cleanly with no tasks/flows created", async () => {
    const playbook = await post("/api/playbooks", founder, { name: "e2e wiring — empty playbook", eventType: "Corporate" });
    expect(playbook.status).toBe(201);

    const leadId = await createLead("e2e wiring — empty playbook lead");
    const res = await post(`/api/leads/${leadId}/convert`, founder, {
      projectName: "e2e wiring project — empty playbook",
      projectType: "Corporate",
      eventDate: "2027-07-01",
      pmId,
      cityId,
      value: 500_000,
      clientName: "e2e wiring client C",
      playbookId: playbook.body.id,
    });
    expect(res.status).toBe(201);
    const projectId = res.body.project.id;
    expect(await prisma.task.count({ where: { projectId } })).toBe(0);
    expect(await prisma.flowInstance.count({ where: { projectId } })).toBe(0);
  });
});
