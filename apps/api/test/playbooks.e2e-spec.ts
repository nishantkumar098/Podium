import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase E: Playbooks CRUD (blueprint §19). Not city-scoped — a playbook is a
 * workspace-level template, same standing as a flow template.
 */
describe("Playbooks (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let pm: string;
  let sales: string;
  let templateId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    pm = await loginAs(app, "rohit.meena@ammbrands.in");
    sales = await loginAs(app, "ananya.joshi@ammbrands.in");
    const template = await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } });
    templateId = template.id;
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const patch = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).patch(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const del = (p: string, t: string) => request(app.getHttpServer()).delete(p).set("Authorization", `Bearer ${t}`);
  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);

  let playbookId: string;

  it("Founder/Admin can create a playbook with tasks and a real flow template", async () => {
    const res = await post("/api/playbooks", founder, {
      name: "e2e — Corporate Gala",
      eventType: "Corporate",
      defaultStages: ["Booking", "Planning", "Execution", "Wrap-up"],
      defaultTasks: [
        { name: "Confirm venue", dueOffsetDays: 30 },
        { name: "Final headcount", dueOffsetDays: 3 },
      ],
      defaultFlowTemplateIds: [templateId],
    });
    expect(res.status).toBe(201);
    expect(res.body.defaultTasks).toHaveLength(2);
    playbookId = res.body.id;

    const fromDb = await prisma.playbook.findUniqueOrThrow({ where: { id: playbookId } });
    expect(fromDb.defaultFlowTemplateIds).toEqual([templateId]);
  });

  it("rejects a defaultFlowTemplateIds entry that doesn't exist", async () => {
    const res = await post("/api/playbooks", founder, {
      name: "e2e — Bad template ref",
      eventType: "Wedding",
      defaultFlowTemplateIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(404);
  });

  it("a PM can view playbooks but not create one", async () => {
    expect((await get("/api/playbooks", pm)).status).toBe(200);
    const res = await post("/api/playbooks", pm, { name: "PM attempt", eventType: "X" });
    expect(res.status).toBe(403);
  });

  it("RBAC: Sales has no playbooks access at all", async () => {
    expect((await get("/api/playbooks", sales)).status).toBe(403);
  });

  it("Founder/Admin can update and soft-delete a playbook", async () => {
    const updated = await patch(`/api/playbooks/${playbookId}`, founder, { name: "e2e — Corporate Gala (renamed)" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("e2e — Corporate Gala (renamed)");

    const removed = await del(`/api/playbooks/${playbookId}`, founder);
    expect(removed.status).toBe(200);
    expect((await get(`/api/playbooks/${playbookId}`, founder)).status).toBe(404);
    const fromDb = await prisma.playbook.findUniqueOrThrow({ where: { id: playbookId } });
    expect(fromDb.deletedAt).not.toBeNull();
  });

  it("every mutation wrote an audit_logs row", async () => {
    expect(await prisma.auditLog.count({ where: { entityId: playbookId, action: "playbook.create" } })).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { entityId: playbookId, action: "playbook.update" } })).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { entityId: playbookId, action: "playbook.delete" } })).toBeGreaterThan(0);
  });
});
