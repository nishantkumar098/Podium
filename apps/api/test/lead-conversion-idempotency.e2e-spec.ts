import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * BUG-007 — ONE LEAD -> AT MOST ONE VALID ACTIVE CONVERSION.
 *
 * Before this, POST /leads/:id/convert did a bare `lead.findFirst` and then
 * created a client, a project, a channel and a notification with nothing in
 * between checking whether it had already done exactly that. A double-click,
 * a retried request, a refreshed success page or two coordinators working the
 * same deal each produced a whole second project — with a second chat channel
 * and, if a playbook was attached, a second full set of tasks and flow
 * instances. The lead row simply kept the last writer's ids; the earlier
 * project stayed behind, orphaned and invisible from the lead.
 *
 * The fix is three layers, and each is tested here on its own terms:
 *   1. a pre-flight check     — the repeat that never touches the database
 *   2. a SELECT ... FOR UPDATE — the concurrent pair
 *   3. a partial unique index  — the guarantee, tested by going around the API
 *      entirely, because a guarantee that only holds when called politely is
 *      not a guarantee.
 *
 * Every assertion counts rows for ONE lead this test created. Counting
 * anything workspace-wide would be meaningless against a shared fixture
 * database that other suites are writing to.
 */
describe("Lead conversion is idempotent (BUG-007)", () => {
  let app: INestApplication;
  let founder: string;
  let pmId: string;
  let cityId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    pmId = (await prisma.user.findFirstOrThrow({ where: { email: "rohit.meena@ammbrands.in" } })).id;
    cityId = (await prisma.city.findFirstOrThrow({ where: { code: "JPR" } })).id;
  });

  afterAll(async () => await app.close());

  const post = (p: string, t: string, b?: unknown) =>
    request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${t}`).send(b ?? {});
  const del = (p: string, t: string) => request(app.getHttpServer()).delete(p).set("Authorization", `Bearer ${t}`);

  async function createLead(name: string) {
    const res = await post("/api/leads", founder, { name, value: 500_000, cityId, ownerId: pmId });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /**
   * Every name this suite writes carries a per-run tag.
   *
   * Without it, "how many clients called X exist?" counts the rows left by
   * every previous run against this shared fixture database — which is how an
   * assertion meant to catch a duplicate ends up reading 5 and 8. Any count
   * that is not scoped to rows this run uniquely owns is not an assertion
   * about the behaviour under test.
   */
  const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

  const conversionBody = (suffix: string) => ({
    projectName: `e2e BUG-007 project ${suffix} ${RUN}`,
    projectType: "Corporate",
    eventDate: "2027-05-01",
    pmId,
    cityId,
    value: 500_000,
    clientName: `e2e BUG-007 client ${suffix} ${RUN}`,
  });

  /** Everything this lead produced — the only honest way to count on a shared database. */
  const conversionsOf = (leadId: string) =>
    prisma.project.findMany({ where: { convertedFromLeadId: leadId }, orderBy: { createdAt: "asc" } });

  it("a second identical request returns the first project instead of creating another", async () => {
    const leadId = await createLead(`e2e BUG-007 — sequential ${RUN}`);

    const first = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("sequential"));
    expect(first.status).toBe(201);
    expect(first.body.alreadyConverted).toBe(false);

    const second = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("sequential"));
    expect(second.status).toBe(201);
    expect(second.body.alreadyConverted).toBe(true);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.body.client.id).toBe(first.body.client.id);

    expect(await conversionsOf(leadId)).toHaveLength(1);
    // The knock-on rows matter as much as the project: a second channel would
    // split the project's conversation in two.
    expect(await prisma.channel.count({ where: { projectId: first.body.project.id } })).toBe(1);
    expect(await prisma.client.count({ where: { name: `e2e BUG-007 client sequential ${RUN}` } })).toBe(1);
  });

  it("a repeat with a DIFFERENT body still does not create a second project", async () => {
    const leadId = await createLead(`e2e BUG-007 — different body ${RUN}`);
    const first = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("body-a"));
    expect(first.status).toBe(201);

    const second = await post(`/api/leads/${leadId}/convert`, founder, {
      ...conversionBody("body-b"),
      projectName: `e2e BUG-007 — a completely different project name ${RUN}`,
    });
    expect(second.status).toBe(201);
    expect(second.body.alreadyConverted).toBe(true);
    expect(second.body.project.name).toBe(first.body.project.name);

    expect(await conversionsOf(leadId)).toHaveLength(1);
    expect(await prisma.client.count({ where: { name: `e2e BUG-007 client body-b ${RUN}` } })).toBe(0);
  });

  it("a repeat whose body is no longer valid is answered, not rejected", async () => {
    // The real shape of a retry: the browser resends, but this time without
    // the value the lead itself still lacks. Validating before checking for an
    // existing conversion would 400 a conversion that already succeeded.
    const lead = await prisma.lead.create({
      data: { workspaceId: (await prisma.workspace.findFirstOrThrow()).id, name: `e2e BUG-007 — valueless ${RUN}`, cityId },
    });
    const body = { ...conversionBody("valueless"), value: 500_000 };

    expect((await post(`/api/leads/${lead.id}/convert`, founder, body)).status).toBe(201);

    const retry = await post(`/api/leads/${lead.id}/convert`, founder, { ...body, value: undefined });
    expect(retry.status).toBe(201);
    expect(retry.body.alreadyConverted).toBe(true);
    expect(await conversionsOf(lead.id)).toHaveLength(1);
  });

  it("five simultaneous requests produce exactly one project", async () => {
    const leadId = await createLead(`e2e BUG-007 — concurrent ${RUN}`);

    // Fired without awaiting in between: these overlap inside the API, which
    // is the case the pre-flight check cannot catch and the row lock must.
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map(() => post(`/api/leads/${leadId}/convert`, founder, conversionBody("concurrent"))),
    );

    for (const res of responses) expect([res.status, res.body.error ?? null]).toEqual([201, null]);

    const projectIds = new Set(responses.map((r) => r.body.project.id));
    expect(projectIds.size).toBe(1);
    expect(responses.filter((r) => r.body.alreadyConverted === false)).toHaveLength(1);

    const projects = await conversionsOf(leadId);
    expect(projects).toHaveLength(1);
    expect(await prisma.channel.count({ where: { projectId: projects[0]!.id } })).toBe(1);
    expect(await prisma.client.count({ where: { name: `e2e BUG-007 client concurrent ${RUN}` } })).toBe(1);
    expect(await prisma.notification.count({ where: { sourceType: "project", sourceId: projects[0]!.id } })).toBe(1);
  });

  it("the lead ends Won and points at the one project that exists", async () => {
    const leadId = await createLead(`e2e BUG-007 — lead state ${RUN}`);
    const res = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("lead-state"));
    expect(res.status).toBe(201);
    await post(`/api/leads/${leadId}/convert`, founder, conversionBody("lead-state"));

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.stage).toBe("WON");
    expect(lead.convertedProjectId).toBe(res.body.project.id);
    expect(lead.convertedClientId).toBe(res.body.client.id);
  });

  /**
   * The database's own guarantee, tested WITHOUT the API. Every check above
   * runs in application code, and application code is exactly what was wrong
   * before. This inserts the second project directly, the way a future code
   * path, a background job or a hand-written statement would.
   */
  it("the database refuses a second live conversion even when the API is bypassed", async () => {
    const leadId = await createLead(`e2e BUG-007 — index ${RUN}`);
    const res = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("index"));
    expect(res.status).toBe(201);
    const first = await prisma.project.findUniqueOrThrow({ where: { id: res.body.project.id } });

    await expect(
      prisma.project.create({
        data: {
          workspaceId: first.workspaceId,
          name: `e2e BUG-007 — smuggled second project ${RUN}`,
          clientId: first.clientId,
          type: first.type,
          cityId: first.cityId,
          eventDate: first.eventDate,
          pmId: first.pmId,
          revenue: 1,
          convertedFromLeadId: leadId,
        },
      }),
    ).rejects.toThrow(/Unique constraint|projects_one_live_conversion_per_lead/i);

    expect(await conversionsOf(leadId)).toHaveLength(1);
  });

  /**
   * The invariant is "at most one VALID ACTIVE conversion", not "at most one
   * ever". A project deleted in error must not leave its lead permanently
   * unconvertible — which is why the index is partial on deleted_at, and why
   * that has to be tested rather than assumed.
   */
  it("a soft-deleted conversion does not lock the lead out forever", async () => {
    const leadId = await createLead(`e2e BUG-007 — undeletable ${RUN}`);
    const first = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("revive-1"));
    expect(first.status).toBe(201);

    await prisma.project.update({ where: { id: first.body.project.id }, data: { deletedAt: new Date() } });

    const second = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("revive-2"));
    expect(second.status).toBe(201);
    expect(second.body.alreadyConverted).toBe(false);
    expect(second.body.project.id).not.toBe(first.body.project.id);

    // Both rows survive — the deleted one as history, and exactly one is live.
    const all = await conversionsOf(leadId);
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.deletedAt === null)).toHaveLength(1);
  });

  /**
   * WHAT THE INVARIANT IS NOT.
   *
   * "One lead -> one project" would be a bug, not a guarantee: AMM's whole
   * business is a client booking them again. The limit is on the CONVERSION —
   * at most one live initial project per conversion — and it must not reach
   * the client that conversion produced.
   */
  describe("the limit is on the conversion, never on the client", () => {
    it("a converted client can hold as many further projects as it likes", async () => {
      const leadId = await createLead(`e2e BUG-007 — repeat customer ${RUN}`);
      const converted = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("repeat-customer"));
      expect(converted.status).toBe(201);
      const clientId = converted.body.client.id as string;

      // Three more events for the same client, the ordinary way — a wedding
      // season, not a duplicate.
      for (const name of ["Sangeet", "Reception", "Anniversary"]) {
        const res = await post("/api/projects", founder, {
          name: `e2e BUG-007 ${name} ${RUN}`,
          clientId,
          type: "Wedding",
          cityId,
          eventDate: "2027-11-20",
          pmId,
        });
        expect([name, res.status]).toEqual([name, 201]);
      }

      expect(await prisma.project.count({ where: { clientId, deletedAt: null } })).toBe(4);
      // ...and exactly one of the four is the conversion.
      expect(await prisma.project.count({ where: { clientId, convertedFromLeadId: { not: null } } })).toBe(1);
    });

    it("a second conversion of a DIFFERENT lead onto the same client is allowed", async () => {
      const firstLead = await createLead(`e2e BUG-007 — client reuse A ${RUN}`);
      const first = await post(`/api/leads/${firstLead}/convert`, founder, conversionBody("reuse-a"));
      expect(first.status).toBe(201);
      const clientId = first.body.client.id as string;

      // A genuinely separate enquiry from a client Podium already knows.
      const secondLead = await createLead(`e2e BUG-007 — client reuse B ${RUN}`);
      const second = await post(`/api/leads/${secondLead}/convert`, founder, {
        ...conversionBody("reuse-b"),
        clientName: undefined,
        clientId,
      });
      expect(second.status).toBe(201);
      expect(second.body.alreadyConverted).toBe(false);
      expect(second.body.client.id).toBe(clientId);
      expect(second.body.project.id).not.toBe(first.body.project.id);
    });
  });

  /**
   * RESTORING an archived conversion, which is where the invariant is met from
   * the other direction: archiving frees the lead to convert again, so the
   * archived project and the new one both claim the same conversion.
   *
   * The database refuses it. What matters here is that a person never sees
   * that refusal — a P2002 naming an index is a 500 that reads like a Podium
   * bug rather than the decision it actually is.
   */
  describe("restoring an archived conversion", () => {
    async function archiveThenReconvert() {
      const leadId = await createLead(`e2e BUG-007 — restore ${RUN}-${Math.random().toString(36).slice(2, 7)}`);
      const a = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("restore-a"));
      expect(a.status).toBe(201);
      expect((await del(`/api/projects/${a.body.project.id}`, founder)).status).toBe(200);
      const b = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("restore-b"));
      expect(b.status).toBe(201);
      expect(b.body.project.id).not.toBe(a.body.project.id);
      return { leadId, a: a.body.project, b: b.body.project };
    }

    it("is refused as a domain conflict, not a database error", async () => {
      const { a, b } = await archiveThenReconvert();

      const res = await post(`/api/projects/${a.id}/restore`, founder);
      expect(res.status).toBe(409);

      // The API's standard envelope is { error: { code, message, details } }
      // (HttpExceptionFilter). Reading res.body.message instead returns "" and
      // every assertion below passes vacuously — which it did on first run.
      expect(res.body.error.code).toBe("CONFLICT");
      const message = String(res.body.error.message ?? "");
      expect(message).not.toBe("");
      // It must say what is in the way and what to do about it...
      expect(message).toContain(b.name);
      expect(message).toContain(b.id);
      expect(message).toMatch(/archive that one first/i);
      // ...and it must not leak the schema. The index name, the Prisma error
      // code and the column name are all implementation detail.
      expect(message).not.toMatch(/projects_one_live_conversion_per_lead|P2002|Unique constraint|converted_from_lead_id/i);
    });

    it("leaves both projects exactly as they were", async () => {
      const { leadId, a, b } = await archiveThenReconvert();
      await post(`/api/projects/${a.id}/restore`, founder);

      const after = await prisma.project.findMany({ where: { convertedFromLeadId: leadId }, orderBy: { createdAt: "asc" } });
      expect(after).toHaveLength(2);
      expect(after[0]!.id).toBe(a.id);
      expect(after[0]!.deletedAt).not.toBeNull(); // still archived — the refusal changed nothing
      expect(after[1]!.id).toBe(b.id);
      expect(after[1]!.deletedAt).toBeNull();
    });

    it("succeeds once the occupying project is archived in its turn", async () => {
      const { a, b } = await archiveThenReconvert();

      expect((await del(`/api/projects/${b.id}`, founder)).status).toBe(200);
      const res = await post(`/api/projects/${a.id}/restore`, founder);
      expect(res.status).toBe(201);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: a.id } })).deletedAt).toBeNull();
    });

    it("restores a project that never came from a conversion without any of this applying", async () => {
      const created = await post("/api/projects", founder, {
        name: `e2e BUG-007 — ordinary project ${RUN}`,
        clientId: (await prisma.client.findFirstOrThrow({ where: { deletedAt: null } })).id,
        type: "Corporate",
        cityId,
        eventDate: "2027-09-09",
        pmId,
      });
      expect(created.status).toBe(201);
      expect((await del(`/api/projects/${created.body.id}`, founder)).status).toBe(200);
      expect((await post(`/api/projects/${created.body.id}/restore`, founder)).status).toBe(201);
    });

    it("two simultaneous restores of two archived conversions cannot both win", async () => {
      // Both were converted from the same lead and both are archived, so the
      // live slot is empty and each passes the pre-check. Only the index can
      // separate them — and the loser must still get a 409, not a 500.
      const leadId = await createLead(`e2e BUG-007 — restore race ${RUN}`);
      const a = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("race-a"));
      await del(`/api/projects/${a.body.project.id}`, founder);
      const b = await post(`/api/leads/${leadId}/convert`, founder, conversionBody("race-b"));
      await del(`/api/projects/${b.body.project.id}`, founder);

      const results = await Promise.all([
        post(`/api/projects/${a.body.project.id}/restore`, founder),
        post(`/api/projects/${b.body.project.id}/restore`, founder),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      expect(await prisma.project.count({ where: { convertedFromLeadId: leadId, deletedAt: null } })).toBe(1);
    });
  });

  it("a repeat does not re-apply the playbook's tasks and flows", async () => {
    const template = await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } });
    const playbook = await post("/api/playbooks", founder, {
      name: `e2e BUG-007 playbook ${RUN}`,
      eventType: "Corporate",
      defaultTasks: [{ name: "e2e BUG-007 task — book venue", dueOffsetDays: 30 }],
      defaultFlowTemplateIds: [template.id],
    });
    expect(playbook.status).toBe(201);

    const leadId = await createLead(`e2e BUG-007 — playbook repeat ${RUN}`);
    const body = { ...conversionBody("playbook"), playbookId: playbook.body.id };
    const first = await post(`/api/leads/${leadId}/convert`, founder, body);
    expect(first.status).toBe(201);
    const projectId = first.body.project.id;
    expect(await prisma.task.count({ where: { projectId } })).toBe(1);
    expect(await prisma.flowInstance.count({ where: { projectId } })).toBe(1);

    expect((await post(`/api/leads/${leadId}/convert`, founder, body)).status).toBe(201);

    // Counted across EVERY project this lead produced, not just the first.
    // Scoped to the first project's id, this assertion passes even with the
    // bug present — the duplicate tasks land on the duplicate project, where
    // a narrower count never looks.
    const projectIds = (await conversionsOf(leadId)).map((p) => p.id);
    expect(await prisma.task.count({ where: { projectId: { in: projectIds } } })).toBe(1);
    expect(await prisma.flowInstance.count({ where: { projectId: { in: projectIds } } })).toBe(1);
    expect(projectIds).toEqual([projectId]);
  });
});
