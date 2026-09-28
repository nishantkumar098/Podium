import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * The flow engine is the platform's actual differentiator (blueprint §6) —
 * this test instantiates a fresh copy of the "Signature serve — Gin & Tonic"
 * template (parallel prep with a join before garnish) and drives it end to
 * end, asserting the AND-join only fires once *every* dependency is
 * COMPLETED, never on the first one.
 */
describe("Flow engine (e2e)", () => {
  let app: INestApplication;
  let token: string;
  let templateId: string;
  let projectId: string;
  let founderId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in");
    const template = await prisma.flowTemplate.findFirstOrThrow({ where: { name: "Signature serve — Gin & Tonic" } });
    templateId = template.id;
    const project = await prisma.project.findFirstOrThrow({ where: { name: { contains: "Rathi" } } });
    projectId = project.id;
    const founder = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
    founderId = founder.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function post(path: string, body?: unknown) {
    return request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});
  }
  function get(path: string) {
    return request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
  }

  it("instantiates with only the no-dependency step READY, everything else LOCKED", async () => {
    const res = await post("/api/flow-instances", {
      templateId,
      projectId,
      ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
    });
    expect(res.status).toBe(201);
    const steps: Array<{ key: string; status: string }> = res.body.steps;
    expect(steps.find((s) => s.key === "a")?.status).toBe("READY");
    for (const key of ["b", "c", "d", "e", "f", "g"]) {
      expect(steps.find((s) => s.key === key)?.status).toBe("LOCKED");
    }
  });

  it("drives the AND-join: f only unlocks once BOTH c and e are complete, not on the first", async () => {
    const instance = (await post("/api/flow-instances", {
      templateId,
      projectId,
      ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
    })).body;
    const stepId = (key: string) => (instance.steps as Array<{ key: string; id: string }>).find((s) => s.key === key)!.id;

    const stateOf = async (key: string) => {
      const fresh = await get(`/api/flow-instances/${instance.id}`);
      return fresh.body.steps.find((s: { key: string; status: string }) => s.key === key).status;
    };

    // a -> unlocks b and c (both depend only on a)
    await post(`/api/flow-steps/${stepId("a")}/complete`).expect(201);
    expect(await stateOf("b")).toBe("READY");
    expect(await stateOf("c")).toBe("READY");

    // b -> unlocks d
    await post(`/api/flow-steps/${stepId("b")}/complete`).expect(201);
    expect(await stateOf("d")).toBe("READY");

    // c alone must NOT unlock f — e (the other half of the join) isn't done yet
    await post(`/api/flow-steps/${stepId("c")}/complete`).expect(201);
    expect(await stateOf("f")).toBe("LOCKED");

    // d -> unlocks e
    await post(`/api/flow-steps/${stepId("d")}/complete`).expect(201);
    expect(await stateOf("e")).toBe("READY");

    // NOW both c and e are complete -> f unlocks
    await post(`/api/flow-steps/${stepId("e")}/complete`).expect(201);
    expect(await stateOf("f")).toBe("READY");

    // finish the chain: f -> g -> flow instance COMPLETED
    await post(`/api/flow-steps/${stepId("f")}/complete`).expect(201);
    expect(await stateOf("g")).toBe("READY");
    await post(`/api/flow-steps/${stepId("g")}/complete`).expect(201);

    const finished = await get(`/api/flow-instances/${instance.id}`);
    expect(finished.body.status).toBe("COMPLETED");
  });

  it("writes an immutable flow_step_runs row for every transition", async () => {
    const instance = (await post("/api/flow-instances", {
      templateId,
      projectId,
      ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
    })).body;
    const aId = (instance.steps as Array<{ key: string; id: string }>).find((s) => s.key === "a")!.id;
    await post(`/api/flow-steps/${aId}/complete`).expect(201);

    const runs = await prisma.flowStepRun.findMany({ where: { stepId: aId } });
    expect(runs.some((r) => r.toStatus === "COMPLETED")).toBe(true);
  });

  it("rejects completing a step that is still LOCKED", async () => {
    const instance = (await post("/api/flow-instances", {
      templateId,
      projectId,
      ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
    })).body;
    const gId = (instance.steps as Array<{ key: string; id: string }>).find((s) => s.key === "g")!.id;
    await post(`/api/flow-steps/${gId}/complete`).expect(400);
  });

  /**
   * Regression test for a real bug a production-readiness audit found:
   * reassignStep never checked whether the new owner actually has
   * city-scope access to the flow's project. Reassigning a step on this
   * (Dehradun) project to a Jaipur-only Operations user silently "succeeded"
   * and left the step owned by someone who would then get a 403 from
   * every other flow-step endpoint for it — reachable only by a manager
   * override, never by its own listed owner. Fixed in
   * FlowsService.reassignStep; pinned down here.
   */
  it("rejects reassigning a step to a user with no city access to the project", async () => {
    const instance = (await post("/api/flow-instances", {
      templateId,
      projectId, // a Dehradun project (Rathi-Sharma)
      ownerOverrides: { a: founderId, b: founderId, c: founderId, d: founderId, e: founderId, f: founderId, g: founderId },
    })).body;
    const bId = (instance.steps as Array<{ key: string; id: string }>).find((s) => s.key === "b")!.id;

    const jaipurOnlyUser = await prisma.user.findFirstOrThrow({ where: { email: "devansh.jain@ammbrands.in" } });
    const rejected = await post(`/api/flow-steps/${bId}/reassign`, { newOwnerId: jaipurOnlyUser.id });
    expect(rejected.status).toBe(400);

    const udaipurUser = await prisma.user.findFirstOrThrow({ where: { email: "lakshya.chouhan@ammbrands.in" } });
    const accepted = await post(`/api/flow-steps/${bId}/reassign`, { newOwnerId: udaipurUser.id });
    expect(accepted.status).toBe(201);
    expect(accepted.body.ownerId).toBe(udaipurUser.id);
  });
});
