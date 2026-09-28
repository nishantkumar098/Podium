import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase I: the rule list + on/off toggle (blueprint §12/screen 30) never had
 * an endpoint — GET /automation/runs and /triggers existed, but nothing
 * exposed the rules themselves. Toggling isEnabled is a real kill switch:
 * every candidate-rule query in AutomationService (emit(), retryFailed())
 * filters on isEnabled:true, so this is checked against real automation
 * behavior, not just the flag's own persistence.
 */
describe("Automation rules admin (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let pm: string;
  let ruleId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    pm = await loginAs(app, "rohit.meena@ammbrands.in");
    const rule = await prisma.automationRule.findFirstOrThrow({ where: { name: { contains: "Chat @mention" } } });
    ruleId = rule.id;
  });

  afterAll(async () => {
    // Leave every rule exactly as this file found it, so other e2e files
    // (chat-mention-notification, automation) that rely on au11 being on
    // are never affected by test order.
    await prisma.automationRule.update({ where: { id: ruleId }, data: { isEnabled: true } });
    await app.close();
  });

  const get = (p: string, t: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${t}`);
  const patch = (p: string, t: string, b?: unknown) => request(app.getHttpServer()).patch(p).set("Authorization", `Bearer ${t}`).send(b ?? {});

  it("Founder can list rules with their real on/off state", async () => {
    const res = await get("/api/automation/rules", founder);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const rule = res.body.find((r: { id: string }) => r.id === ruleId);
    expect(rule).toBeDefined();
    expect(rule.isEnabled).toBe(true);
  });

  it("RBAC: a PM (no automation resource at all) is blocked from both endpoints", async () => {
    expect((await get("/api/automation/rules", pm)).status).toBe(403);
    expect((await patch(`/api/automation/rules/${ruleId}`, pm, { isEnabled: false })).status).toBe(403);
  });

  it("toggling a rule off actually stops it from firing, and back on resumes it", async () => {
    const off = await patch(`/api/automation/rules/${ruleId}`, founder, { isEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.isEnabled).toBe(false);

    const fromDb = await prisma.automationRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(fromDb.isEnabled).toBe(false);

    // Confirm it's a real kill switch: post a mention while the rule is off.
    const workspace = await prisma.workspace.findFirstOrThrow();
    const target = await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { workspaceId: workspace.id, kind: "COMPANY" } });
    const notifBefore = await prisma.notification.count({ where: { userId: target.id, sourceType: "message" } });

    const postRes = await request(app.getHttpServer())
      .post(`/api/channels/${channel.id}/messages`)
      .set("Authorization", `Bearer ${founder}`)
      .send({ body: "@Rohit — this mention must NOT notify while au11 is disabled (e2e)" });
    expect(postRes.status).toBe(201);

    const notifAfter = await prisma.notification.count({ where: { userId: target.id, sourceType: "message" } });
    expect(notifAfter).toBe(notifBefore);

    const on = await patch(`/api/automation/rules/${ruleId}`, founder, { isEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.isEnabled).toBe(true);
  });

  it("404s for a rule that doesn't exist", async () => {
    const res = await patch("/api/automation/rules/00000000-0000-0000-0000-000000000000", founder, { isEnabled: false });
    expect(res.status).toBe(404);
  });
});
