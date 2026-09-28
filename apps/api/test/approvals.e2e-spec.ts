import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * BUG-009 (Phase B.1): the generic approval path — CREATIVE/BUDGET/CLIENT/
 * VENDOR/PAYMENT-type approvals reached from the /approvals screen, as
 * distinct from ProcurementService.decideRequestApproval() which already had
 * both these guards from an earlier audit cycle (see procurement.e2e-spec.ts
 * "the requester cannot approve their own request").
 *
 * ApprovalsService.decide() used to update the row unconditionally: no
 * PENDING check (a settled approval could be silently re-decided) and no
 * self-approval block (the requester could decide their own approval,
 * regardless of role). Both are fixed and asserted here against real
 * database state, following the same "create as user A, attempt to decide
 * as A -> blocked, decide as B -> the real outcome" structure used for
 * expenses in Phase B.
 */
describe("Approvals — generic decision path (e2e)", () => {
  let app: INestApplication;
  let founder: string; // Anant — requests the approval
  let finance: string; // Neha — decides it, a different person
  let projectId: string;
  const createdApprovalIds: string[] = [];

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    finance = await loginAs(app, "neha.agarwal@ammbrands.in");
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    projectId = project.id;
  });

  afterAll(async () => {
    if (createdApprovalIds.length) {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: createdApprovalIds } } });
      await prisma.approval.deleteMany({ where: { id: { in: createdApprovalIds } } });
    }
    await app.close();
  });

  const as = (token: string) => ({
    post: (p: string, b?: unknown) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(b ?? {}),
  });

  async function createApproval(requesterToken: string, title = "Phase B.1 test approval") {
    const res = await as(requesterToken).post("/api/approvals", {
      projectId,
      title,
      type: "VENDOR",
      approverRef: "Finance",
    });
    expect(res.status).toBe(201);
    createdApprovalIds.push(res.body.id);
    return res.body.id as string;
  }

  it("REFUSES self-approval — the requester cannot decide their own approval", async () => {
    const id = await createApproval(founder);
    const res = await as(founder).post(`/api/approvals/${id}/decide`, { decision: "APPROVED" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/cannot decide it yourself/i);

    const stored = await prisma.approval.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe("PENDING");
    expect(stored.decidedAt).toBeNull();
  });

  it("approves when a DIFFERENT user decides, recording an audit row", async () => {
    const id = await createApproval(founder);
    const res = await as(finance).post(`/api/approvals/${id}/decide`, { decision: "APPROVED" });
    expect(res.status).toBe(201);

    const stored = await prisma.approval.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe("APPROVED");
    expect(stored.decidedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "approval.approved" } });
    expect(audit).not.toBeNull();
    const neha = await prisma.user.findFirstOrThrow({ where: { email: "neha.agarwal@ammbrands.in" } });
    expect(audit!.actorId).toBe(neha.id);
  });

  it("REFUSES to re-decide an already-settled approval", async () => {
    const id = await createApproval(founder);
    expect((await as(finance).post(`/api/approvals/${id}/decide`, { decision: "APPROVED" })).status).toBe(201);

    const again = await as(finance).post(`/api/approvals/${id}/decide`, { decision: "REJECTED", reason: "changed my mind" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/cannot be decided again/i);

    // Genuinely untouched — still APPROVED, not flipped to REJECTED.
    expect((await prisma.approval.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
  });

  it("REFUSES to re-decide even a REJECTED approval (not just an APPROVED one)", async () => {
    const id = await createApproval(founder);
    expect((await as(finance).post(`/api/approvals/${id}/decide`, { decision: "REJECTED", reason: "no budget" })).status).toBe(201);

    const again = await as(finance).post(`/api/approvals/${id}/decide`, { decision: "APPROVED" });
    expect(again.status).toBe(409);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id } })).status).toBe("REJECTED");
  });
});
