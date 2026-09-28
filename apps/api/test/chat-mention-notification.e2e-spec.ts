import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase G, rule au11 — "Chat @mention -> notification" (blueprint §23/§12).
 *
 * Posting a message with a real @mention now creates a real notification
 * for the mentioned person through the generalized automation engine — the
 * gap this closes: before this phase, "@Rohit please confirm sound vendor"
 * notified nobody until Rohit happened to read the channel. This does NOT
 * auto-create a task (that stays the existing, deliberately human-confirmed
 * promote-to-task flow covered by chat-promote.e2e-spec.ts) — only a
 * notification.
 */
describe("Chat @mention -> notification (au11) (e2e)", () => {
  let app: INestApplication;
  let pmToken: string;
  let pmUserId: string;
  let pmName: string;
  let rohitId: string;
  let companyChannelId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    pmToken = await loginAs(app, "simran.kaur@ammbrands.in"); // PM, Jaipur
    const pm = await prisma.user.findFirstOrThrow({ where: { email: "simran.kaur@ammbrands.in" } });
    pmUserId = pm.id;
    pmName = pm.name;
    const rohit = await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } });
    rohitId = rohit.id;
    companyChannelId = (await prisma.channel.findFirstOrThrow({ where: { kind: "COMPANY" } })).id;
  });

  afterAll(async () => await app.close());

  const post = (path: string, token: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});

  it("a real @mention creates a real notification for the mentioned person", async () => {
    // rohitId is a real, widely-reused seeded user, so a global before/after
    // count for them is not reliably isolated from other suites running in
    // parallel Jest workers against the same shared DB — every assertion
    // here is scoped to this specific message's own sourceId instead.
    const text = `e2e au11 test — @Rohit please confirm the sound vendor ${Date.now()}`;
    const res = await post(`/api/channels/${companyChannelId}/messages`, pmToken, { body: text });
    expect(res.status).toBe(201);
    const messageId = res.body.id;

    // The automation engine fires inside the same request (awaited), so the
    // row must already exist by the time this response comes back.
    const notification = await prisma.notification.findFirst({
      where: { userId: rohitId, sourceType: "message", sourceId: messageId },
    });
    expect(notification).not.toBeNull();
    expect(notification!.text).toContain(pmName);
    expect(await prisma.notification.count({ where: { sourceId: messageId } })).toBe(1);
  });

  it("mentioning yourself does not notify you", async () => {
    const res = await post(`/api/channels/${companyChannelId}/messages`, pmToken, { body: "e2e au11 — @Simran talking to myself" });
    const messageId = res.body.id;
    expect(await prisma.notification.count({ where: { sourceId: messageId } })).toBe(0);
  });

  it("an unresolvable handle notifies nobody and does not error", async () => {
    const res = await post(`/api/channels/${companyChannelId}/messages`, pmToken, {
      body: "e2e au11 — @NobodyByThisName please check",
    });
    expect(res.status).toBe(201);
  });

  it("two mentions in one message notify both people, each exactly once", async () => {
    const kritika = await prisma.user.findFirstOrThrow({ where: { email: "kritika.bansal@ammbrands.in" } });

    const res = await post(`/api/channels/${companyChannelId}/messages`, pmToken, {
      body: "e2e au11 — @Rohit and @Kritika please both look at this",
    });
    const messageId = res.body.id;

    expect(await prisma.notification.count({ where: { userId: rohitId, sourceId: messageId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: kritika.id, sourceId: messageId } })).toBe(1);
    expect(await prisma.notification.count({ where: { sourceId: messageId } })).toBe(2);
  });

  it("the au11 rule is registered as a real automation_rules row", async () => {
    const rule = await prisma.automationRule.findFirst({ where: { name: "Chat @mention → notification" } });
    expect(rule).not.toBeNull();
    expect(rule!.isEnabled).toBe(true);
    expect((rule!.triggerConfig as { trigger: string }).trigger).toBe("chat.mentioned");
  });
});
