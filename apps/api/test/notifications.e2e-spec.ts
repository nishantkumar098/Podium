import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase G: the notifications read surface. Every notification row is
 * created elsewhere (flows, event day, automation handlers, chat
 * mentions...) — this module only reads and marks-read a caller's own
 * rows, which is why there is no RBAC gate beyond authentication (same
 * standing as GET /users/me).
 */
describe("Notifications (e2e)", () => {
  let app: INestApplication;
  let tokenA: string;
  let userAId: string;
  let tokenB: string;
  let userBId: string;
  let workspaceId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    tokenA = await loginAs(app, "anant.sharma@ammbrands.in");
    const a = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
    userAId = a.id;
    workspaceId = a.workspaceId;
    tokenB = await loginAs(app, "rohit.meena@ammbrands.in");
    userBId = (await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } })).id;
  });

  afterAll(async () => await app.close());

  const get = (path: string, token: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
  const post = (path: string, token: string) => request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`);

  it("lists only the caller's own notifications, newest first", async () => {
    const n1 = await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e notif 1", icon: "✎" } });
    await new Promise((r) => setTimeout(r, 5));
    const n2 = await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e notif 2", icon: "✎" } });
    await prisma.notification.create({ data: { workspaceId, userId: userBId, text: "e2e notif for someone else", icon: "✎" } });

    const res = await get("/api/notifications", tokenA);
    expect(res.status).toBe(200);
    expect(res.body.some((n: { id: string }) => n.id === n2.id)).toBe(true);
    expect(res.body.some((n: { id: string }) => n.id === n1.id)).toBe(true);
    expect(res.body.every((n: { userId: string }) => n.userId === userAId)).toBe(true);
    // newest first
    const idx1 = res.body.findIndex((n: { id: string }) => n.id === n1.id);
    const idx2 = res.body.findIndex((n: { id: string }) => n.id === n2.id);
    expect(idx2).toBeLessThan(idx1);
  });

  it("unreadOnly=true only returns unread rows, and a marked-read row drops out of it", async () => {
    // userAId is a real, widely-reused seeded user — another suite running
    // in a parallel Jest worker can create or read their notifications at
    // the same time (automation.e2e-spec.ts's low-stock scenario notifies
    // every Founder, Anant included), so this checks a specific row's
    // presence/absence rather than a before/after delta on a shared total.
    const n = await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e unread test", icon: "✎" } });
    const beforeList = await get("/api/notifications?unreadOnly=true", tokenA);
    expect(beforeList.status).toBe(200);
    expect(beforeList.body.some((x: { id: string }) => x.id === n.id)).toBe(true);

    const marked = await post(`/api/notifications/${n.id}/read`, tokenA);
    expect(marked.status).toBe(201);
    expect(marked.body.readAt).not.toBeNull();

    const afterList = await get("/api/notifications?unreadOnly=true", tokenA);
    expect(afterList.body.some((x: { id: string }) => x.id === n.id)).toBe(false);

    const countRes = await get("/api/notifications/unread-count", tokenA);
    expect(countRes.status).toBe(200);
    expect(typeof countRes.body.count).toBe("number");
  });

  it("marking an already-read notification read again is a harmless no-op", async () => {
    const n = await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e double-read", icon: "✎", readAt: new Date() } });
    const res = await post(`/api/notifications/${n.id}/read`, tokenA);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(n.id);
  });

  it("a user cannot mark someone else's notification as read", async () => {
    const n = await prisma.notification.create({ data: { workspaceId, userId: userBId, text: "e2e someone else's", icon: "✎" } });
    const res = await post(`/api/notifications/${n.id}/read`, tokenA);
    expect(res.status).toBe(404);
    const fromDb = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(fromDb.readAt).toBeNull();
  });

  it("read-all marks every one of the caller's unread notifications read, and none of anyone else's", async () => {
    await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e read-all 1", icon: "✎" } });
    await prisma.notification.create({ data: { workspaceId, userId: userAId, text: "e2e read-all 2", icon: "✎" } });
    // A specific, freshly-created row for userB, not a total count — userB
    // (a real seeded user) can be touched by other tests running in a
    // parallel worker against the same shared DB, so a before/after delta
    // on their total unread count is not reliably isolated; this row is.
    const otherUnread = await prisma.notification.create({ data: { workspaceId, userId: userBId, text: "e2e read-all untouched", icon: "✎" } });

    const res = await post("/api/notifications/read-all", tokenA);
    expect(res.status).toBe(201);
    expect(res.body.updated).toBeGreaterThan(0);

    expect(await prisma.notification.count({ where: { userId: userAId, readAt: null } })).toBe(0);
    const stillUnread = await prisma.notification.findUniqueOrThrow({ where: { id: otherUnread.id } });
    expect(stillUnread.readAt).toBeNull();
  });
});
