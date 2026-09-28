// MAIL_MODE must be set before the Nest module is instantiated —
// MailConfigService resolves the mode once, in its constructor. `sandbox`
// renders every message in full but never opens an SMTP connection, so this
// file can assert on real e-mail content with no risk of a message reaching
// an actual AMM client.
process.env.MAIL_MODE = "sandbox";

import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { MailService } from "../src/common/mail/mail.service";
import { InvoicesService } from "../src/invoices/invoices.service";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase A — invoice MANAGEMENT (the engine itself is covered by
 * invoices.e2e-spec.ts and is deliberately not re-tested here).
 *
 * Everything below asserts against database state, not just HTTP codes:
 * the OVERDUE sweep must leave an audit row and a notification behind, the
 * cancel path must actually flip the stored status, and the e-mail path must
 * produce a real rendered message with a real PDF attached.
 */
describe("Invoices — management (e2e)", () => {
  let app: INestApplication;
  let token: string;
  let ctx: { clientId: string; projectId: string; cityId: string };

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance Manager

    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const client = await prisma.client.findFirstOrThrow({ where: { name: { contains: "Cognizant" } } });
    const project = await prisma.project.findFirstOrThrow({ where: { clientId: client.id } });
    ctx = { clientId: client.id, projectId: project.id, cityId: jaipur.id };
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});
  const get = (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  async function createDraft(opts: { dueDate?: Date; rate?: number } = {}) {
    const res = await post("/api/invoices", {
      clientId: ctx.clientId,
      projectId: ctx.projectId,
      cityId: ctx.cityId,
      dueDate: (opts.dueDate ?? new Date(Date.now() + 14 * 86400000)).toISOString(),
      items: [{ description: "Phase A test line", qty: 1, rate: opts.rate ?? 50000, hsnSac: "9963" }],
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  // ------------------------------------------------------------------ 3.2
  describe("cancel (3.2)", () => {
    it("cancels a DRAFT invoice and records it in the database", async () => {
      const id = await createDraft();
      const res = await post(`/api/invoices/${id}/cancel`, { reason: "Raised against the wrong project" });
      expect(res.status).toBe(201);

      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("CANCELLED");
      expect(stored.deletedAt).not.toBeNull();
    });

    it("refuses to cancel an ISSUED invoice — a credit note is the only correction path", async () => {
      const id = await createDraft();
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);

      const res = await post(`/api/invoices/${id}/cancel`, {});
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/credit note/i);

      // And the invoice is genuinely untouched.
      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("ISSUED");
      expect(stored.deletedAt).toBeNull();
    });
  });

  // ------------------------------------------------------------------ 3.1
  describe("overdue sweep (3.1)", () => {
    it("transitions a past-due ISSUED invoice to OVERDUE with an audit row and a notification", async () => {
      const id = await createDraft({ dueDate: new Date(Date.now() - 3 * 86400000) });
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);

      const result = await app.get(InvoicesService).sweepOverdue();
      expect(result.invoiceIds).toContain(id);

      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(stored.status).toBe("OVERDUE");

      const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "invoice.marked_overdue" } });
      expect(audit).not.toBeNull();
      expect(audit!.actorId).toBeNull(); // written by the system sweep, not a user

      const project = await prisma.project.findUniqueOrThrow({ where: { id: ctx.projectId } });
      if (project.pmId) {
        const note = await prisma.notification.findFirst({ where: { sourceType: "invoice", sourceId: id } });
        expect(note).not.toBeNull();
      }
    });

    /**
     * TIMEZONE (BUG found 2026-09-16 while auditing the dormant worker).
     *
     * Due dates arrive as `2026-09-16` and are stored as midnight UTC, which
     * is 05:30 in Jaipur. The sweep compared `dueDate < now`, so at any time
     * after 05:30 IST **on the morning an invoice fell due** it was marked
     * OVERDUE and the PM was told a client who still had a full working day
     * was late. Every invoice, every time.
     *
     * The clock is injected here rather than mocked: these are the two
     * instants that matter either side of the boundary.
     */
    it("is not overdue during the business day it falls due, in IST", async () => {
      const dueDate = new Date("2027-03-15"); // stored 2027-03-15T00:00:00Z
      const id = await createDraft({ dueDate });
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);

      // 09:00 IST on the 15th — the day it is due, and a working day.
      const duringTheDueDay = new Date("2027-03-15T03:30:00Z");
      const result = await app.get(InvoicesService).sweepOverdue(duringTheDueDay);
      expect(result.invoiceIds).not.toContain(id);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("ISSUED");
    });

    it("becomes overdue once that business day has closed", async () => {
      const dueDate = new Date("2027-03-15");
      const id = await createDraft({ dueDate });
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);

      // 00:30 IST on the 16th — the 15th is over in Jaipur.
      const afterTheDueDay = new Date("2027-03-15T19:00:00Z");
      const result = await app.get(InvoicesService).sweepOverdue(afterTheDueDay);
      expect(result.invoiceIds).toContain(id);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("OVERDUE");
    });

    it("tells the PM the due date as it reads in India, not in UTC", async () => {
      // 20:00 UTC on the 15th is 01:30 IST on the 16th. A date-only due date
      // never lands here, but a datetime one does, and toISOString() would
      // tell the PM the wrong day. Chosen precisely because the two renderings
      // disagree — against the same date at midnight UTC this assertion
      // passes whichever way the code renders it, and proves nothing.
      const id = await createDraft({ dueDate: new Date("2027-03-15T20:00:00Z") });
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);
      await app.get(InvoicesService).sweepOverdue(new Date("2027-03-20T00:00:00Z"));

      const note = await prisma.notification.findFirst({ where: { sourceType: "invoice", sourceId: id } });
      expect(note).not.toBeNull();
      expect(note!.text).toContain("2027-03-16");
      expect(note!.text).not.toContain("2027-03-15");
    });

    it("never drags a PAID invoice back to OVERDUE, even past its due date", async () => {
      const id = await createDraft({ dueDate: new Date(Date.now() - 3 * 86400000), rate: 10000 });
      expect((await post(`/api/invoices/${id}/issue`)).status).toBe(201);
      // 10,000 + 18% GST = 11,800 — pay it in full.
      expect((await post(`/api/invoices/${id}/payments`, { amount: 11800, method: "BANK_TRANSFER" })).status).toBe(201);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("PAID");

      await app.get(InvoicesService).sweepOverdue();
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("PAID");
    });

    it("is idempotent — a second sweep re-transitions nothing", async () => {
      const id = await createDraft({ dueDate: new Date(Date.now() - 86400000) });
      await post(`/api/invoices/${id}/issue`);
      await app.get(InvoicesService).sweepOverdue();
      const second = await app.get(InvoicesService).sweepOverdue();
      expect(second.invoiceIds).not.toContain(id);
    });
  });

  // ------------------------------------------------------------------ 3.3
  describe("PDF (3.3)", () => {
    it("renders a real PDF from stored invoice data", async () => {
      const id = await createDraft();
      await post(`/api/invoices/${id}/issue`);

      const res = await get(`/api/invoices/${id}/pdf`).buffer().parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(1000);

      // The minted invoice number must appear in the rendered document, and
      // the filename must be filesystem-safe (invoice numbers contain "/").
      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(res.headers["content-disposition"]).toContain(stored.invoiceNo.replace(/\//g, "-"));
    });

    it("refuses to render an invoice the caller's city scope excludes", async () => {
      // Rohit Meena is scoped to Dehradun only; this invoice is billed from Jaipur.
      const id = await createDraft();
      const udaipurOnly = await loginAs(app, "rohit.meena@ammbrands.in");
      const res = await request(app.getHttpServer())
        .get(`/api/invoices/${id}/pdf`)
        .set("Authorization", `Bearer ${udaipurOnly}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  // ------------------------------------------------------------------ 3.4
  describe("e-mail (3.4)", () => {
    it("refuses to e-mail a DRAFT invoice", async () => {
      const id = await createDraft();
      const res = await post(`/api/invoices/${id}/email`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/draft/i);
    });

    it("renders a real message with the PDF attached, and sends nothing in sandbox mode", async () => {
      const id = await createDraft();
      await post(`/api/invoices/${id}/issue`);
      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { client: true } });

      // The seeded client needs an address to e-mail; skip cleanly rather
      // than asserting a false pass if the fixture has none.
      if (!stored.client.email) {
        await prisma.client.update({ where: { id: stored.clientId }, data: { email: "billing@example.invalid" } });
      }

      const res = await post(`/api/invoices/${id}/email`);
      expect(res.status).toBe(201);
      expect(res.body.mode).toBe("sandbox");

      const outbox = app.get(MailService).recentSandboxMail();
      const sent = outbox.find((m) => m.subject.includes(stored.invoiceNo));
      expect(sent).toBeDefined();
      expect(sent!.attachments).toHaveLength(1);
      expect(sent!.attachments![0].contentType).toBe("application/pdf");
      expect(sent!.attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");

      const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "invoice.emailed" } });
      expect(audit).not.toBeNull();
    });
  });
});
