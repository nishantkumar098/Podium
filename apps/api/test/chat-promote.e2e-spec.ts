import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { findMentionCandidates, resolveMentions, suggestTaskName } from "../src/chat/mentions";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 4's remaining half: @mention -> task promotion (blueprint §23).
 *
 * The end-to-end half of this suite runs against the seeded demo fixture
 * because it needs a project channel, and the production database currently
 * holds ZERO projects — AMM's real records contain no bookable event with a
 * date, city and confirmed value, so none was invented (see STATUS.md §0.-1).
 * The mentioned employees are real either way: the 15-person roster survives
 * the real-data import untouched.
 */
describe("Chat @mention -> task promotion (e2e)", () => {
  let app: INestApplication;
  let pmToken: string;
  let projectChannelId: string;
  let companyChannelId: string;
  let rohit: { id: string; name: string };
  let pmUserId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    pmToken = await loginAs(app, "rohit.meena@ammbrands.in"); // Project Manager, Dehradun
    const r = await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } });
    rohit = { id: r.id, name: r.name };
    pmUserId = r.id;

    // A project channel in a city Rohit can actually reach.
    const project = await prisma.project.findFirstOrThrow({ where: { pmId: r.id }, include: { city: true } });
    const channel = await prisma.channel.findFirstOrThrow({ where: { projectId: project.id } });
    projectChannelId = channel.id;
    companyChannelId = (await prisma.channel.findFirstOrThrow({ where: { kind: "COMPANY" } })).id;
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { sourceMessageId: { not: null } } });
    await app.close();
  });

  const post = (path: string, token: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});
  const get = (path: string, token: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  async function say(body: string, token = pmToken, channelId = projectChannelId) {
    const res = await post(`/api/channels/${channelId}/messages`, token, { body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  // ---------------------------------------------------------------- parser
  describe("mention parsing (pure unit)", () => {
    const roster = [
      { id: "1", name: "Rohit Meena", email: "rohit.meena@ammbrands.in" },
      { id: "2", name: "Simran Kaur", email: "simran.kaur@ammbrands.in" },
    ];

    it("pulls the handle out of the prototype's worked example", () => {
      expect(findMentionCandidates("@Rohit please confirm sound vendor").map((c) => c.handle)).toEqual(["Rohit"]);
    });

    it("stops a handle at punctuation", () => {
      expect(findMentionCandidates("@Rohit, thanks").map((c) => c.handle)).toEqual(["Rohit"]);
    });

    it("does not treat an e-mail address as a mention", () => {
      expect(findMentionCandidates("mail anant@ammbrands.in about it")).toEqual([]);
    });

    it("resolves by first name, full name and e-mail local part", () => {
      for (const handle of ["Rohit", "RohitMeena", "rohit.meena"]) {
        expect(resolveMentions(`@${handle} do the thing`, roster)[0].user?.id).toBe("1");
      }
    });

    it("refuses to guess when a first name is ambiguous", () => {
      const twoRohits = [...roster, { id: "9", name: "Rohit Sharma", email: "rohit.sharma@ammbrands.in" }];
      const [m] = resolveMentions("@Rohit please confirm", twoRohits);
      expect(m.user).toBeNull();
      expect(m.ambiguousWith).toEqual(["Rohit Meena", "Rohit Sharma"]);
    });

    it("suggests a task name with the mention and filler stripped", () => {
      expect(suggestTaskName("@Rohit please confirm sound vendor")).toBe("Confirm sound vendor");
    });
  });

  // ------------------------------------------------------------ end to end
  it("previews a promotion: resolves the real employee, finds the project, suggests a name", async () => {
    const messageId = await say("@Rohit please confirm sound vendor");
    const res = await get(`/api/messages/${messageId}/promotion-preview`, pmToken);
    expect(res.status).toBe(200);
    expect(res.body.suggestedOwner.id).toBe(rohit.id);
    expect(res.body.suggestedName).toBe("Confirm sound vendor");
    expect(res.body.project).not.toBeNull();
    expect(res.body.dueAtRequired).toBe(true); // never inferred
  });

  it("promotes a real message to a real task, links it, and posts a bot confirmation", async () => {
    const messageId = await say("@Rohit please confirm sound vendor for the Dehradun build");
    const dueAt = new Date(Date.now() + 3 * 86_400_000);

    const res = await post(`/api/messages/${messageId}/promote-task`, pmToken, {
      name: "Confirm sound vendor",
      ownerId: rohit.id,
      dueAt: dueAt.toISOString(),
    });
    expect(res.status).toBe(201);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(task.sourceMessageId).toBe(messageId);
    expect(task.ownerId).toBe(rohit.id);
    expect(task.status).toBe("PLANNED");

    // The channel must show what happened — a task nobody was told about is a
    // silent half-success.
    const bot = await prisma.message.findFirst({
      where: { channelId: projectChannelId, authorId: null, body: { contains: "Confirm sound vendor" } },
      orderBy: { createdAt: "desc" },
    });
    expect(bot).not.toBeNull();

    const notification = await prisma.notification.findFirst({ where: { userId: rohit.id, sourceType: "task", sourceId: task.id } });
    expect(notification).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { entityId: task.id, action: "task.promoted_from_message" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(pmUserId);
  });

  it("refuses to promote the same message twice", async () => {
    const messageId = await say("@Rohit double promotion check");
    const body = { name: "First", ownerId: rohit.id, dueAt: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await post(`/api/messages/${messageId}/promote-task`, pmToken, body)).status).toBe(201);
    const second = await post(`/api/messages/${messageId}/promote-task`, pmToken, { ...body, name: "Second" });
    expect(second.status).toBe(400);
    expect(await prisma.task.count({ where: { sourceMessageId: messageId } })).toBe(1);
  });

  it("refuses a message in a non-project channel (there is no project to attach to)", async () => {
    const founderToken = await loginAs(app, "anant.sharma@ammbrands.in");
    const messageId = await say("@Rohit company-wide note", founderToken, companyChannelId);
    const res = await post(`/api/messages/${messageId}/promote-task`, founderToken, {
      name: "Nope",
      ownerId: rohit.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a Podium Bot message", async () => {
    const bot = await prisma.message.create({ data: { channelId: projectChannelId, authorId: null, body: "@Rohit bot says do this" } });
    const res = await post(`/api/messages/${bot.id}/promote-task`, pmToken, {
      name: "From a bot",
      ownerId: rohit.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("RBAC: a role without tasks:view cannot even preview", async () => {
    const financeToken = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance: no tasks:* grants
    const messageId = await say("@Rohit finance should not see this");
    expect((await get(`/api/messages/${messageId}/promotion-preview`, financeToken)).status).toBe(403);
  });

  it("RBAC: a non-member without tasks:create is refused the promotion itself", async () => {
    // Priya (Creative, Mumbai) holds tasks:view/edit but NOT tasks:create, and
    // is not a member of this Dehradun project.
    const creativeToken = await loginAs(app, "priya.rathore@ammbrands.in");
    const messageId = await say("@Rohit creative tries to promote");
    const res = await post(`/api/messages/${messageId}/promote-task`, creativeToken, {
      name: "Should not exist",
      ownerId: rohit.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect([403]).toContain(res.status);
    expect(await prisma.task.count({ where: { sourceMessageId: messageId } })).toBe(0);
  });
});
