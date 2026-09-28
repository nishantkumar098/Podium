import type { INestApplication } from "@nestjs/common";
import { getStorageToken, ThrottlerStorageService } from "@nestjs/throttler";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import request from "supertest";
import { prisma } from "@podium/db";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Sign-in rules (2026-09-18):
 *   - log in with a username (the person's name), never sign up;
 *   - an account starts with no password; the first password typed at sign-in
 *     (entered twice) becomes permanent;
 *   - only a Founder or Admin can reset it, which returns the account to the
 *     no-password state; an Admin cannot reset a Founder; nobody resets
 *     themselves.
 * Every test uses throwaway users created and removed here.
 */
describe("Username sign-in and password lifecycle (e2e)", () => {
  let app: INestApplication;
  let workspaceId: string;
  const createdUserIds: string[] = [];
  const PW = "a-permanent-pass";

  beforeAll(async () => {
    app = await bootstrapTestApp();
    workspaceId = (await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } })).workspaceId;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: createdUserIds } }, { entityId: { in: createdUserIds } }] } });
      await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  // Many /auth/login calls per test would trip the production rate limit.
  beforeEach(() => {
    app.get<ThrottlerStorageService>(getStorageToken()).storage.clear();
  });

  async function createUser(opts: { password?: string; role?: string } = {}) {
    const username = `test.${randomUUID().slice(0, 8)}`;
    const user = await prisma.user.create({
      data: {
        workspaceId,
        name: username.replace(".", " "),
        username,
        email: null,
        passwordHash: opts.password ? await bcrypt.hash(opts.password, 4) : null,
      },
    });
    createdUserIds.push(user.id);
    if (opts.role) {
      const role = await prisma.role.findFirstOrThrow({ where: { workspaceId, name: opts.role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    return user;
  }

  const login = (body: Record<string, unknown>) => request(app.getHttpServer()).post("/api/auth/login").send(body);

  // --------------------------------------------------------------- sign-in
  it("signs in by username, and accepts the name typed with spaces and capitals", async () => {
    const u = await createUser({ password: PW });
    expect((await login({ username: u.username, password: PW })).status).toBe(201);
    expect((await login({ username: `  ${u.name!.toUpperCase()} `, password: PW })).status).toBe(201);
  });

  it("gives the same answer for an unknown username and a wrong password", async () => {
    const u = await createUser({ password: PW });
    const unknown = await login({ username: "no.such.person", password: PW });
    const wrong = await login({ username: u.username, password: "wrong-password" });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  // ------------------------------------------------------ first sign-in
  it("asks a first-time user to confirm, without storing anything yet", async () => {
    const u = await createUser();
    const res = await login({ username: u.username, password: PW });
    expect(res.status).toBe(428);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBeNull();
  });

  it("rejects a mismatched confirmation and a too-short password", async () => {
    const u = await createUser();
    expect((await login({ username: u.username, password: PW, confirmPassword: "different-pass" })).status).toBe(400);
    expect((await login({ username: u.username, password: "short", confirmPassword: "short" })).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBeNull();
  });

  it("makes the first password permanent — it cannot be claimed again with another one", async () => {
    const u = await createUser();
    expect((await login({ username: u.username, password: PW, confirmPassword: PW })).status).toBe(201);
    expect((await login({ username: u.username, password: PW })).status).toBe(201);
    expect((await login({ username: u.username, password: "another-password", confirmPassword: "another-password" })).status).toBe(401);
  });

  it("lets exactly one of two simultaneous first sign-ins set the password", async () => {
    const u = await createUser();
    const [a, b] = await Promise.all([
      login({ username: u.username, password: "first-choice-1", confirmPassword: "first-choice-1" }),
      login({ username: u.username, password: "second-choice-2", confirmPassword: "second-choice-2" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
  });

  it("locks an account after 5 wrong passwords", async () => {
    const u = await createUser({ password: PW });
    for (let i = 0; i < 5; i++) await login({ username: u.username, password: "wrong-password" });
    expect((await login({ username: u.username, password: PW })).status).toBe(401);
  });

  // --------------------------------------------------------- no sign-up
  it("has no sign-up, invite or self-service password-change endpoint", async () => {
    const token = await loginAs(app, "anant.sharma@ammbrands.in");
    const auth = { Authorization: `Bearer ${token}` };
    const server = app.getHttpServer();
    expect((await request(server).post("/api/auth/register").send({})).status).toBe(404);
    expect((await request(server).post("/api/auth/accept-invite").send({})).status).toBe(404);
    expect((await request(server).post("/api/auth/change-password").set(auth).send({})).status).toBe(404);
    expect((await request(server).post(`/api/users/${randomUUID()}/invite`).set(auth).send({})).status).toBe(404);
  });

  // -------------------------------------------------------------- resets
  it("lets a Founder reset a password: sessions end and the next sign-in sets a new one", async () => {
    const u = await createUser({ password: PW });
    const theirSession = await login({ username: u.username, password: PW });
    const founder = await loginAs(app, "anant.sharma@ammbrands.in");

    const reset = await request(app.getHttpServer()).post(`/api/users/${u.id}/reset-password`).set("Authorization", `Bearer ${founder}`);
    expect(reset.status).toBe(201);

    const refreshed = await request(app.getHttpServer()).post("/api/auth/refresh").send({ refreshToken: theirSession.body.refreshToken });
    expect(refreshed.status).toBe(401);
    expect((await login({ username: u.username, password: PW })).status).toBe(428);
    expect((await login({ username: u.username, password: "brand-new-password", confirmPassword: "brand-new-password" })).status).toBe(201);
  });

  it("refuses resets from any role other than Founder or Admin", async () => {
    const target = await createUser({ password: PW });
    const ops = await createUser({ password: PW, role: "Operations" }); // runs delivery, but holds no settings:edit
    const token = (await login({ username: ops.username, password: PW })).body.accessToken;
    const res = await request(app.getHttpServer()).post(`/api/users/${target.id}/reset-password`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("does not let an Admin reset a Founder, or anyone reset themselves", async () => {
    const admin = await createUser({ password: PW, role: "Admin" });
    const adminToken = (await login({ username: admin.username, password: PW })).body.accessToken;
    const founder = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
    const server = app.getHttpServer();

    expect((await request(server).post(`/api/users/${founder.id}/reset-password`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(403);
    expect((await request(server).post(`/api/users/${admin.id}/reset-password`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(400);
  });
});
