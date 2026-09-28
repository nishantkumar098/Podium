import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 9 (blueprint §16). AMM Brands' real Google Workspace credentials are
 * NOT available in this environment, so what is verified here is that the
 * integration is honest about that:
 *
 *  - with no credentials it refuses with 503 and setup instructions, rather
 *    than returning an empty inbox that reads as "no mail today";
 *  - sandbox mode never simulates a successful OAuth flow;
 *  - the linking logic — which is the part that can be built without Google —
 *    really does attach messages to real client/vendor/lead records.
 *
 * There is no test asserting a live Gmail call succeeds, because no such call
 * has ever been made from this build.
 */
describe("Google integration (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in");
  });
  afterAll(async () => await app.close());

  const get = (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${token}`);
  const post = (p: string, b?: unknown) =>
    request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(b ?? {});

  it("reports the real mode and says plainly why it is blocked", async () => {
    const res = await get("/api/integrations/google/status");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("disabled"); // the shipped default
    expect(res.body.connected).toBe(false);
    expect(res.body.credentialsPresent).toBe(false);
    expect(res.body.blockedReason).toMatch(/credentials|integration-setup/i);
  });

  it("refuses to produce an OAuth URL without credentials, with actionable guidance", async () => {
    const res = await get("/api/integrations/google/auth-url");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toMatch(/integration-setup\.md/);
  });

  it("refuses a token exchange without credentials — no fake connected account", async () => {
    const res = await post("/api/integrations/google/callback", { code: "fake-code" });
    expect(res.status).toBe(503);
    expect(await prisma.googleAccount.count()).toBe(0);
  });

  it("refuses to sync or list mail while disabled, rather than returning an empty inbox", async () => {
    expect((await post("/api/integrations/google/sync")).status).toBe(503);
    expect((await get("/api/integrations/google/emails")).status).toBe(503);
  });

  it("no Google account row can exist without a real token exchange", async () => {
    expect(await prisma.googleAccount.count()).toBe(0);
  });
});

/**
 * Sandbox mode, booted as a separate app with the env var set, so the mode
 * selection and the linking logic are both really exercised rather than
 * asserted about.
 */
describe("Google integration — sandbox mode (e2e)", () => {
  let app: INestApplication;
  let token: string;
  let clientEmail: string;

  beforeAll(async () => {
    process.env.GOOGLE_INTEGRATION_MODE = "sandbox";
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in");

    // Give a real client the sandbox sender's address so linking has something
    // true to match against.
    clientEmail = "sandbox.sender@example.invalid";
    const ws = await prisma.workspace.findFirstOrThrow();
    await prisma.client.updateMany({
      where: { workspaceId: ws.id, segment: "EVENT_CLIENT" },
      data: {},
    });
    const anyClient = await prisma.client.findFirstOrThrow({ where: { workspaceId: ws.id } });
    await prisma.client.update({ where: { id: anyClient.id }, data: { email: clientEmail } });
  });

  afterAll(async () => {
    await prisma.email.deleteMany({ where: { isSandbox: true } });
    process.env.GOOGLE_INTEGRATION_MODE = "disabled";
    await app.close();
  });

  const get = (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${token}`);
  const post = (p: string, b?: unknown) =>
    request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(b ?? {});

  it("says it is sandbox and explains that nothing real is contacted", async () => {
    const res = await get("/api/integrations/google/status");
    expect(res.body.mode).toBe("sandbox");
    expect(res.body.blockedReason).toMatch(/sandbox/i);
  });

  it("still refuses to fake an OAuth flow in sandbox mode", async () => {
    expect((await get("/api/integrations/google/auth-url")).status).toBe(503);
    expect((await post("/api/integrations/google/callback", { code: "x" })).status).toBe(503);
  });

  it("syncs fixture messages, marks them as sandbox, and links one to a real client", async () => {
    const res = await post("/api/integrations/google/sync");
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("sandbox");
    expect(res.body.created).toBe(2);
    expect(res.body.links.client).toBe(1); // the sender we attached to a real client

    const stored = await prisma.email.findMany({ where: { isSandbox: true } });
    expect(stored.length).toBe(2);
    expect(stored.every((e) => e.isSandbox)).toBe(true);
    expect(stored.every((e) => e.fromAddress.endsWith("example.invalid"))).toBe(true);

    const linked = stored.find((e) => e.fromAddress === clientEmail);
    expect(linked?.linkedClientId).not.toBeNull();
  });

  it("a replayed sync does not duplicate messages (incremental cursor works)", async () => {
    const before = await prisma.email.count({ where: { isSandbox: true } });
    await post("/api/integrations/google/sync");
    const after = await prisma.email.count({ where: { isSandbox: true } });
    // The cursor advances, so a replay either finds nothing new or finds the
    // next fixture pair — what it must never do is re-insert what it has.
    const dupes = await prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(*) AS c FROM (SELECT gmail_message_id FROM emails GROUP BY 1 HAVING COUNT(*) > 1) d`;
    expect(Number(dupes[0].c)).toBe(0);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("sandbox never sends mail", async () => {
    const { SandboxGmailProvider } = await import("../src/google/gmail.provider");
    await expect(new SandboxGmailProvider().send()).rejects.toThrow(/never sends mail/i);
  });
});
