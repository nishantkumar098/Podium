import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import { randomUUID } from "crypto";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Regression tests for the invoice defects found in the 2026-09-18 test pass.
 * Every test creates its own client + project, so nothing here depends on or
 * disturbs shared seed rows.
 */
describe("Invoice fixes — 2026-09-18 test pass (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in"); // Founder: every invoices/payments permission
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r.send(body ?? {});
  };
  const get = (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  /** A fresh client + project billed from Jaipur. `gstStateCode: null` models every imported real client. */
  async function fixture(client: { gstStateCode?: string | null; gstin?: string | null } = {}) {
    const workspace = await prisma.workspace.findFirstOrThrow();
    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const pm = await prisma.user.findFirstOrThrow({ where: { email: "anant.sharma@ammbrands.in" } });
    const c = await prisma.client.create({
      data: {
        workspaceId: workspace.id,
        name: `Invoice-fix client ${randomUUID().slice(0, 8)}`,
        type: "INDIVIDUAL",
        gstStateCode: client.gstStateCode === undefined ? "08" : client.gstStateCode,
        gstin: client.gstin ?? null,
      },
    });
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: `Invoice-fix project ${c.id.slice(0, 8)}`, clientId: c.id, type: "Wedding", cityId: jaipur.id, eventDate: new Date(), pmId: pm.id },
    });
    return { client: c, project, city: jaipur };
  }

  const ITEMS = [{ description: "Event bar", qty: 1, rate: 100000, hsnSac: "9963" }]; // total 1,18,000 at 18%

  async function draft(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
    const res = await post("/api/invoices", {
      clientId: f.client.id,
      projectId: f.project.id,
      cityId: f.city.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: ITEMS,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function issued(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
    const id = await draft(f, extra);
    const res = await post(`/api/invoices/${id}/issue`);
    expect(res.status).toBe(201);
    return id;
  }

  const status = async (id: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).status;

  // -------------------------------------------------------------- issuing
  it("issues an invoice for a client with no GST state code, treating supply as intra-state", async () => {
    const f = await fixture({ gstStateCode: null });
    const id = await issued(f);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.placeOfSupply).toBe("08");
    expect(inv.cgst.toNumber()).toBe(9000);
    expect(inv.igst.toNumber()).toBe(0);
    expect(inv.total.toNumber()).toBe(118000);
  });

  it("derives place of supply from the client's GSTIN when no state code is keyed", async () => {
    const f = await fixture({ gstStateCode: null, gstin: "27AABCM1234F1Z5" });
    const id = await issued(f);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.placeOfSupply).toBe("27");
    expect(inv.igst.toNumber()).toBe(18000);
  });

  it("stores provisional totals on a draft instead of zeros", async () => {
    const f = await fixture();
    const id = await draft(f);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(inv.status).toBe("DRAFT");
    expect(inv.total.toNumber()).toBe(118000);
  });

  it("refuses a project that belongs to a different client", async () => {
    const a = await fixture();
    const b = await fixture();
    const res = await post("/api/invoices", {
      clientId: a.client.id,
      projectId: b.project.id,
      cityId: a.city.id,
      dueDate: new Date(Date.now() + 86400000).toISOString(),
      items: ITEMS,
    });
    expect(res.status).toBe(400);
  });

  it("renders a DRAFT only as a marked draft PDF, never under its placeholder number", async () => {
    const f = await fixture();
    const id = await draft(f);
    const res = await get(`/api/invoices/${id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("DRAFT");
    expect(res.headers["content-disposition"]).not.toMatch(/DRAFT-[0-9a-f]{8}-/);
  });

  // ------------------------------------------------------------ estimates
  it("numbers estimates on their own series without consuming a tax-invoice number", async () => {
    const f = await fixture();
    const first = await prisma.invoice.findUniqueOrThrow({ where: { id: await issued(f) } });
    const estimate = await prisma.invoice.findUniqueOrThrow({ where: { id: await issued(f, { docType: "ESTIMATE" }) } });
    const second = await prisma.invoice.findUniqueOrThrow({ where: { id: await issued(f) } });

    expect(estimate.invoiceNo).toMatch(/^AMM\/JPR\/\d{2}-\d{2}\/EST-\d{4}$/);
    const seq = (no: string) => Number(no.split("/").pop());
    expect(seq(second.invoiceNo)).toBe(seq(first.invoiceNo) + 1);
  });

  it("refuses payments and credit notes against an estimate", async () => {
    const f = await fixture();
    const id = await issued(f, { docType: "ESTIMATE" });
    expect((await post(`/api/invoices/${id}/payments`, { amount: 1000, method: "UPI" })).status).toBe(400);
    expect((await post(`/api/invoices/${id}/credit-notes`, { amount: 1000, reason: "x" })).status).toBe(400);
  });

  // ------------------------------------------------------------ settlement
  it("refuses a payment larger than the balance, and any payment once PAID", async () => {
    const f = await fixture();
    const id = await issued(f);
    expect((await post(`/api/invoices/${id}/payments`, { amount: 118001, method: "UPI" })).status).toBe(400);
    expect((await post(`/api/invoices/${id}/payments`, { amount: 118000, method: "UPI" })).status).toBe(201);
    expect(await status(id)).toBe("PAID");
    expect((await post(`/api/invoices/${id}/payments`, { amount: 1, method: "UPI" })).status).toBe(409);
  });

  it("reaches PAID when payments cover the amount left after a credit note", async () => {
    const f = await fixture();
    const id = await issued(f);
    expect((await post(`/api/invoices/${id}/credit-notes`, { amount: 18000, reason: "scope reduced" })).status).toBe(201);
    expect((await post(`/api/invoices/${id}/payments`, { amount: 100000, method: "BANK_TRANSFER" })).status).toBe(201);
    expect(await status(id)).toBe("PAID");
  });

  it("refuses a credit note larger than what is billed", async () => {
    const f = await fixture();
    const id = await issued(f);
    expect((await post(`/api/invoices/${id}/credit-notes`, { amount: 118001, reason: "too much" })).status).toBe(400);
  });

  it("re-opens a PAID invoice when a debit note is raised", async () => {
    const f = await fixture();
    const id = await issued(f);
    await post(`/api/invoices/${id}/payments`, { amount: 118000, method: "UPI" });
    expect(await status(id)).toBe("PAID");
    expect((await post(`/api/invoices/${id}/debit-notes`, { amount: 5000, reason: "extra hours" })).status).toBe(201);
    expect(await status(id)).toBe("PARTIALLY_PAID");
  });

  it("settles correctly when two payments land at the same time", async () => {
    const f = await fixture();
    const id = await issued(f);
    const [a, b] = await Promise.all([
      post(`/api/invoices/${id}/payments`, { amount: 59000, method: "UPI" }),
      post(`/api/invoices/${id}/payments`, { amount: 59000, method: "UPI" }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await status(id)).toBe("PAID");
  });

  // ---------------------------------------------------------- idempotency
  it("rejects an idempotency key replayed against a different invoice", async () => {
    const f = await fixture();
    const one = await issued(f);
    const two = await issued(f);
    const key = randomUUID();
    expect((await post(`/api/invoices/${one}/payments`, { amount: 1000, method: "UPI" }, { "idempotency-key": key })).status).toBe(201);
    expect((await post(`/api/invoices/${two}/payments`, { amount: 1000, method: "UPI" }, { "idempotency-key": key })).status).toBe(409);
  });
});
