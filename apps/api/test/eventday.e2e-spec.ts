import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 8's remaining half (blueprint §20): run-of-show, crew check-in, and
 * the incident log with auto-escalation.
 *
 * The escalation assertions check the database, not the response body: a HIGH
 * incident must leave a real `risks` row, a real notification and a real bot
 * message behind, because "stored the incident" and "escalated the incident"
 * are exactly the two things that are easy to confuse.
 */
describe("Event Day (e2e)", () => {
  let app: INestApplication;
  let pmToken: string;
  let opsToken: string;
  let projectId: string;
  let pmId: string;
  let opsId: string;
  let opsName: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    pmToken = await loginAs(app, "rohit.meena@ammbrands.in"); // PM, Dehradun
    const pm = await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } });
    pmId = pm.id;
    const project = await prisma.project.findFirstOrThrow({ where: { pmId: pm.id } });
    projectId = project.id;

    // An Operations user in the same city, so city scope isn't what's under test.
    const ops = await prisma.user.findFirstOrThrow({ where: { email: "lakshya.chouhan@ammbrands.in" } }); // Ops, Dehradun
    opsId = ops.id;
    opsName = ops.name;
    opsToken = await loginAs(app, ops.email);

    await prisma.runsheetItem.deleteMany({ where: { runsheet: { projectId } } });
    await prisma.runsheet.deleteMany({ where: { projectId } });
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown) =>
    request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const patch = (p: string, t: string, b?: unknown) =>
    request(app.getHttpServer()).patch(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);

  let runsheetId: string;
  let cueId: string;

  it("creates a run-of-show and returns it in cue order", async () => {
    const res = await post(`/api/projects/${projectId}/runsheet`, pmToken, {
      items: [
        { scheduledTime: "18:00", text: "Bar setup complete", ownerId: opsId },
        { scheduledTime: "16:30", text: "Crew call", ownerId: pmId, sortOrder: 0 },
        { scheduledTime: "21:00", text: "Last orders", ownerId: opsId },
      ],
    });
    expect(res.status).toBe(201);
    runsheetId = res.body.id;

    const fetched = await get(`/api/projects/${projectId}/runsheet`, pmToken);
    expect(fetched.body.items.map((i: { text: string }) => i.text)).toEqual([
      "Crew call", "Bar setup complete", "Last orders",
    ]);
    cueId = fetched.body.items.find((i: { text: string }) => i.text === "Bar setup complete").id;
  });

  it("rejects a cue time that isn't event-day-local HH:MM", async () => {
    const res = await post(`/api/runsheets/${runsheetId}/items`, pmToken, {
      scheduledTime: "6pm", text: "Bad time", ownerId: opsId,
    });
    expect(res.status).toBe(400);
  });

  it("the cue owner can tick their own cue, and it is recorded with a timestamp", async () => {
    const res = await patch(`/api/runsheet-items/${cueId}/done`, opsToken, { done: true });
    expect(res.status).toBe(200);
    const item = await prisma.runsheetItem.findUniqueOrThrow({ where: { id: cueId } });
    expect(item.doneAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: cueId, action: "runsheet_item.done" } })).toBeGreaterThan(0);
  });

  it("a colleague who is neither the cue owner nor the PM nor a manager cannot tick it", async () => {
    // Priya is Creative (tasks:edit, no projects:edit) and not this cue's owner.
    const creative = await loginAs(app, "priya.rathore@ammbrands.in");
    const res = await patch(`/api/runsheet-items/${cueId}/done`, creative, { done: false });
    expect([403]).toContain(res.status);
  });

  it("checks a real employee in, and is idempotent on a repeat", async () => {
    const first = await post(`/api/projects/${projectId}/checkins`, opsToken, {});
    expect(first.status).toBe(201);
    const second = await post(`/api/projects/${projectId}/checkins`, opsToken, {});
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.eventDayCheckin.count({ where: { projectId, userId: opsId } })).toBe(1);
  });

  /**
   * BUG-011 (Phase D.3). Found building the Phase D frontend: userId/
   * reportedById on check-ins and incidents have no Prisma relation to User
   * (unlike, say, runsheet items' project relation), so the list endpoints
   * returned bare ids with no name attached — every list view had to guess a
   * display name from a project roster that the reporting/checking-in user
   * need not even belong to.
   */
  it("BUG-011: the check-in list resolves a real display name for each checker-in", async () => {
    const res = await get(`/api/projects/${projectId}/checkins`, opsToken);
    expect(res.status).toBe(200);
    const row = res.body.find((c: { userId: string }) => c.userId === opsId);
    expect(row).toBeDefined();
    expect(row.userName).toBe(opsName);
  });

  it("a PM (projects:edit) can check a colleague in; a non-manager cannot check someone else in", async () => {
    const byPm = await post(`/api/projects/${projectId}/checkins`, pmToken, { userId: pmId });
    expect(byPm.status).toBe(201);

    const creative = await loginAs(app, "priya.rathore@ammbrands.in");
    const res = await post(`/api/projects/${projectId}/checkins`, creative, { userId: pmId });
    expect([403]).toContain(res.status);
  });

  it("a LOW incident is logged but does NOT escalate", async () => {
    const risksBefore = await prisma.risk.count({ where: { projectId } });
    const res = await post(`/api/projects/${projectId}/incidents`, opsToken, {
      severity: "LOW", text: "Ice delivery ten minutes late",
    });
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(false);
    expect(res.body.raisedRiskId).toBeNull();
    expect(await prisma.risk.count({ where: { projectId } })).toBe(risksBefore);
  });

  it("a HIGH incident escalates for real: risk row, PM notification, bot message, audit", async () => {
    const risksBefore = await prisma.risk.count({ where: { projectId } });

    const res = await post(`/api/projects/${projectId}/incidents`, opsToken, {
      severity: "HIGH", text: "Guest injured by broken glassware at the main bar",
    });
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    const incident = await prisma.eventDayIncident.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(incident.raisedRiskId).not.toBeNull();

    // The risk is real, owned by the PM, and points back at the incident.
    const risk = await prisma.risk.findUniqueOrThrow({ where: { id: incident.raisedRiskId! } });
    expect(risk.severity).toBe("HIGH");
    expect(risk.ownerId).toBe(pmId);
    expect(risk.sourceIncidentId).toBe(incident.id);
    expect(risk.status).toBe("OPEN");
    expect(await prisma.risk.count({ where: { projectId } })).toBe(risksBefore + 1);

    const notification = await prisma.notification.findFirst({
      where: { userId: pmId, sourceType: "event_day_incident", sourceId: incident.id },
    });
    expect(notification).not.toBeNull();

    const channel = await prisma.channel.findFirst({ where: { projectId } });
    if (channel) {
      const bot = await prisma.message.findFirst({
        where: { channelId: channel.id, authorId: null, body: { contains: "broken glassware" } },
      });
      expect(bot).not.toBeNull();
    }

    const audit = await prisma.auditLog.findFirst({ where: { entityId: incident.id, action: "event_day.incident_logged" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(opsId);
  });

  it("BUG-011: the incident list resolves a real display name for the reporter", async () => {
    const res = await get(`/api/projects/${projectId}/incidents`, opsToken);
    expect(res.status).toBe(200);
    const row = res.body.find((i: { text: string }) => i.text === "Guest injured by broken glassware at the main bar");
    expect(row).toBeDefined();
    expect(row.reportedByName).toBe(opsName);
  });

  it("a CRITICAL incident escalates at CRITICAL severity", async () => {
    const res = await post(`/api/projects/${projectId}/incidents`, opsToken, {
      severity: "CRITICAL", text: "Fire in the back-of-house prep area",
    });
    const incident = await prisma.eventDayIncident.findUniqueOrThrow({ where: { id: res.body.id } });
    const risk = await prisma.risk.findUniqueOrThrow({ where: { id: incident.raisedRiskId! } });
    expect(risk.severity).toBe("CRITICAL");
  });

  it("city scoping: a Goa-scoped user cannot see or touch this Dehradun project's event day", async () => {
    const goa = await loginAs(app, "meera.deshpande@ammbrands.in"); // Ops, Goa
    expect((await get(`/api/projects/${projectId}/runsheet`, goa)).status).toBe(403);
    expect((await post(`/api/projects/${projectId}/incidents`, goa, { severity: "LOW", text: "nope" })).status).toBe(403);
  });

  it("RBAC: a role without tasks:edit cannot log an incident", async () => {
    const finance = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance
    const res = await post(`/api/projects/${projectId}/incidents`, finance, { severity: "LOW", text: "finance note" });
    expect(res.status).toBe(403);
  });
});
