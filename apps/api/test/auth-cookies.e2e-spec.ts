import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { bootstrapTestApp } from "./support";

/**
 * Phase H: the API now mirrors login/refresh/accept-invite's tokens into
 * httpOnly cookies (accessToken, refreshToken) alongside the existing JSON
 * body, and accepts either the cookie or the Authorization header on every
 * protected route. These tests drive the cookie path in isolation — with a
 * real supertest cookie jar and, deliberately, no Authorization header at
 * all — to prove the browser-facing flow actually works end to end, not
 * just that it typechecks.
 */
describe("Cookie-based auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets httpOnly accessToken/refreshToken cookies on login and authenticates a subsequent request via cookie alone", async () => {
    const agent = request.agent(app.getHttpServer());

    const loginRes = await agent
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "Podium123!" })
      .expect(201);

    const setCookie = loginRes.headers["set-cookie"] as unknown as string[];
    expect(setCookie).toBeDefined();
    const accessCookie = setCookie.find((c) => c.startsWith("accessToken="));
    const refreshCookie = setCookie.find((c) => c.startsWith("refreshToken="));
    expect(accessCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();
    expect(accessCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/HttpOnly/i);

    // No Authorization header anywhere below — the agent's cookie jar is the
    // only credential in play, exactly as a real browser would present it.
    const meRes = await agent.get("/api/users/me").expect(200);
    expect(meRes.body.email).toBe("anant.sharma@ammbrands.in");
  });

  it("still authenticates via the Authorization header with no cookie present (non-browser callers)", async () => {
    const loginRes = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "Podium123!" })
      .expect(201);
    const token = loginRes.body.accessToken as string;

    await request(app.getHttpServer()).get("/api/users/me").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("refreshes via the cookie alone (empty body) and rotates both cookies", async () => {
    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "Podium123!" })
      .expect(201);
    const originalRefreshCookie = (loginRes.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("refreshToken="),
    );

    const refreshRes = await agent.post("/api/auth/refresh").send({}).expect(201);
    const rotatedRefreshCookie = (refreshRes.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("refreshToken="),
    );
    expect(rotatedRefreshCookie).toBeDefined();
    expect(rotatedRefreshCookie).not.toBe(originalRefreshCookie);

    // The new access cookie actually authenticates.
    await agent.get("/api/users/me").expect(200);
  });

  it("rejects /auth/refresh when neither a cookie nor a body token is present", async () => {
    await request(app.getHttpServer()).post("/api/auth/refresh").send({}).expect(400);
  });

  /**
   * The reason lib/api.ts funnels every caller through one shared in-flight
   * refresh: rotation means the *second* concurrent refresh would present a
   * token the first one already revoked, and get this 401 — logging out a
   * user for the crime of having six queries on screen at once. Pinned here
   * so the rotation semantics that dedup depends on can't change silently.
   */
  it("a refresh token that has already been rotated away is rejected", async () => {
    const loginRes = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "Podium123!" })
      .expect(201);
    const firstRefreshToken = loginRes.body.refreshToken as string;

    await request(app.getHttpServer()).post("/api/auth/refresh").send({ refreshToken: firstRefreshToken }).expect(201);

    // Same token, second time — it was revoked by the rotation above.
    await request(app.getHttpServer()).post("/api/auth/refresh").send({ refreshToken: firstRefreshToken }).expect(401);
  });

  it("logs out via the cookie alone, clears both cookies, and the session stops working", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/api/auth/login")
      .send({ username: "anant.sharma@ammbrands.in", password: "Podium123!" })
      .expect(201);
    await agent.get("/api/users/me").expect(200);

    const logoutRes = await agent.post("/api/auth/logout").send({}).expect(201);
    const clearedCookies = logoutRes.headers["set-cookie"] as unknown as string[];
    expect(clearedCookies.some((c) => /^accessToken=;/.test(c))).toBe(true);
    expect(clearedCookies.some((c) => /^refreshToken=;/.test(c))).toBe(true);

    // The agent's jar now holds the (cleared, empty-valued) cookies — no
    // credential remains, so the protected route is unreachable.
    await agent.get("/api/users/me").expect(401);
  });
});
