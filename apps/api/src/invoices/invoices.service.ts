import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@podium/db";
import { randomUUID } from "crypto";
import type { CreateAdjustmentNoteInput, CreateInvoiceInput, RecordPaymentInput, UpdateInvoiceInput } from "@podium/shared-types";
import { businessDateString, endOfBusinessDay } from "../common/business-time";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { WhatsAppConfigService } from "../whatsapp/whatsapp-config.service";
import { WhatsAppProvider } from "../whatsapp/whatsapp.provider";
import { InvoiceLinkService } from "./invoice-link.service";
import { MailService } from "../common/mail/mail.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";
import { InvoicePdfService, type InvoicePdfData } from "./invoice-pdf.service";
import {
  amountDue,
  computeTotals,
  financialYearFor,
  outstanding,
  placeOfSupplyFor,
  recipientStateCode,
  settlementStatus,
} from "./invoice-math";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

const sum = (xs: ReadonlyArray<{ amount: Prisma.Decimal }>) => xs.reduce((s, x) => s + x.amount.toNumber(), 0);

/** Row lock for anything that reads the money position and then writes a status from it. */
async function lockInvoice(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`);
}

/**
 * The invoice engine (blueprint §17). Two rules are load-bearing and must
 * never be relaxed:
 *  1. Numbering (AMM/{CITY}/{FY}/{SEQ}) is sequential per city per FY and
 *     gap-free — the counter row is locked (SELECT ... FOR UPDATE) in the
 *     same transaction that mints the number, so two concurrent "issue"
 *     calls for the same city/FY can never collide or skip.
 *  2. An ISSUED invoice is immutable. There is no update path for its
 *     items/amounts once issued — corrections are a credit_note or
 *     debit_note, always. This service does not expose an "edit issued
 *     invoice" method at all, not even a guarded one.
 */
/** Everything the invoice screen and the PDF renderer need, in one place. */
const INVOICE_INCLUDE = {
  items: { orderBy: [{ scope: "asc" }, { sortOrder: "asc" }] },
  payments: true,
  creditNotes: true,
  debitNotes: true,
  client: true,
  project: true,
  city: true,
  brand: true,
  // `satisfies` rather than `as const`: it validates the shape against
  // Prisma while leaving the arrays mutable, which Prisma requires.
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly pdf: InvoicePdfService,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsAppProvider,
    private readonly whatsappConfig: WhatsAppConfigService,
    private readonly links: InvoiceLinkService,
  ) {}

  /**
   * The invoice register, with each invoice's money position worked out here
   * (paid, balance after credit/debit notes, and whether it is past due) so
   * the screen's totals, ageing and chase list all agree with the server's
   * own arithmetic. Related sums are separate grouped queries fired together
   * rather than per-invoice includes — one round trip, not five.
   */
  async list(user: RequestUser, cityId?: string) {
    const db = this.prisma.client;
    const scope = this.cityScope.scopeFilter(user, cityId);
    const where = { workspaceId: user.workspaceId, deletedAt: null, ...scope };
    const onThese = { invoice: where };
    const [rows, paid, credited, debited, clients, projects, cities] = await Promise.all([
      db.invoice.findMany({
        where,
        select: {
          id: true, invoiceNo: true, docType: true, status: true, issueDate: true, dueDate: true, taxableAmount: true, total: true,
          clientId: true, projectId: true, cityId: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      db.payment.groupBy({ by: ["invoiceId"], where: onThese, _sum: { amount: true } }),
      db.creditNote.groupBy({ by: ["invoiceId"], where: onThese, _sum: { amount: true } }),
      db.debitNote.groupBy({ by: ["invoiceId"], where: onThese, _sum: { amount: true } }),
      db.client.findMany({ where: { invoices: { some: where } }, select: { id: true, name: true, email: true } }),
      db.project.findMany({ where: { invoices: { some: where } }, select: { id: true, name: true } }),
      db.city.findMany({ where: { workspaceId: user.workspaceId }, select: { id: true, name: true } }),
    ]);
    const sumOf = (xs: Array<{ invoiceId: string; _sum: { amount: { toNumber(): number } | null } }>) =>
      new Map(xs.map((x) => [x.invoiceId, x._sum.amount?.toNumber() ?? 0]));
    const [paidBy, creditBy, debitBy] = [sumOf(paid), sumOf(credited), sumOf(debited)];
    const clientBy = new Map(clients.map((c) => [c.id, c]));
    const projectBy = new Map(projects.map((p) => [p.id, p]));
    const cityBy = new Map(cities.map((c) => [c.id, c.name]));
    const today = businessDateString(new Date());

    return rows.map((r) => {
      const total = r.total.toNumber();
      const p = paidBy.get(r.id) ?? 0;
      const live = r.docType === "TAX_INVOICE" && ["ISSUED", "PARTIALLY_PAID", "OVERDUE"].includes(r.status);
      const balance = live ? Math.max(0, outstanding(total, p, creditBy.get(r.id) ?? 0, debitBy.get(r.id) ?? 0)) : 0;
      return {
        ...r,
        paid: p,
        balance,
        overdue: live && balance > 0 && businessDateString(r.dueDate) < today,
        client: clientBy.get(r.clientId) ?? { id: r.clientId, name: "—", email: null },
        project: projectBy.get(r.projectId) ?? { id: r.projectId, name: "—" },
        city: { id: r.cityId, name: cityBy.get(r.cityId) ?? "—" },
      };
    });
  }

  async get(user: RequestUser, id: string) {
    const invoice = await this.prisma.client.invoice.findFirst({
      where: { id, workspaceId: user.workspaceId, deletedAt: null },
      include: INVOICE_INCLUDE,
    });
    if (!invoice) throw new NotFoundException("Invoice not found.");
    this.cityScope.assertCanAccessCity(user, invoice.cityId);
    return invoice;
  }

  /** Creates a DRAFT invoice — no number is minted, nothing is final, still freely editable via delete+recreate. */
  async create(user: RequestUser, input: CreateInvoiceInput, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.client.invoice.findUnique({ where: { idempotencyKey } });
      if (existing) {
        // A key is a replay token for ONE caller's request, not a lookup: an
        // unscoped match would hand back another workspace's invoice.
        if (existing.workspaceId !== user.workspaceId) throw new ConflictException("Idempotency key already used.");
        return existing;
      }
    }
    this.cityScope.assertCanAccessCity(user, input.cityId);

    const [client, project, city] = await Promise.all([
      this.prisma.client.client.findFirst({ where: { id: input.clientId, workspaceId: user.workspaceId } }),
      this.prisma.client.project.findFirst({ where: { id: input.projectId, workspaceId: user.workspaceId } }),
      this.prisma.client.city.findFirst({ where: { id: input.cityId, workspaceId: user.workspaceId } }),
    ]);
    if (!client) throw new NotFoundException("Client not found.");
    if (!project) throw new NotFoundException("Project not found.");
    if (!city) throw new NotFoundException("City not found.");
    if (project.clientId !== client.id) {
      throw new BadRequestException("That project belongs to a different client — an invoice's client must be its project's client.");
    }
    if (input.brandId) {
      const brand = await this.prisma.client.brand.findFirst({ where: { id: input.brandId, workspaceId: user.workspaceId } });
      if (!brand) throw new NotFoundException("Brand not found.");
    }

    // Provisional figures, computed exactly as issue() will compute them, so a
    // draft shows its real total instead of 0.00 everywhere it is listed.
    const placeOfSupply = placeOfSupplyFor(client, city.gstStateCode);
    const totals = computeTotals(input.items, city.gstStateCode, placeOfSupply);

    return this.prisma.client.invoice.create({
      data: {
        workspaceId: user.workspaceId,
        invoiceNo: `DRAFT-${randomUUID()}`, // placeholder, replaced by a real number on issue
        clientId: input.clientId,
        projectId: input.projectId,
        cityId: input.cityId,
        brandId: input.brandId,
        docType: input.docType,
        dueDate: input.dueDate,
        paymentTerms: input.paymentTerms,
        quotationRef: input.quotationRef,
        serviceLocation: input.serviceLocation,
        status: "DRAFT",
        placeOfSupply,
        ...totals,
        idempotencyKey,
        items: {
          // sortOrder is the caller's array order: the printed document
          // numbers lines 01, 02… within each scope, and an invoice whose
          // lines reshuffle between renders is not a document anyone can
          // reconcile against.
          create: input.items.map((i, index) => ({
            description: i.description,
            detail: i.detail,
            qty: i.qty,
            unit: i.unit,
            rate: i.rate,
            discountPct: i.discountPct,
            hsnSac: i.hsnSac,
            gstRate: i.gstRate,
            scope: i.scope,
            sortOrder: index,
          })),
        },
        createdById: user.id,
      },
      include: { items: true },
    });
  }

  /**
   * Locks the invoice number, computes the final GST split from the
   * issuing city's GST state code vs. the client's, and flips DRAFT -> ISSUED.
   * From this point on the invoice is immutable — see class doc.
   */
  async issue(user: RequestUser, id: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null }, include: { items: true, city: true, client: true } });
      if (!invoice) throw new NotFoundException("Invoice not found.");
      this.cityScope.assertCanAccessCity(user, invoice.cityId);
      if (invoice.status !== "DRAFT") {
        throw new ConflictException(`Invoice is already ${invoice.status} — only a DRAFT invoice can be issued.`);
      }
      const issuedAt = new Date();
      const invoiceNo = await this.mintInvoiceNumber(tx, user.workspaceId, invoice.cityId, invoice.city.code, issuedAt, invoice.docType);
      const placeOfSupply = placeOfSupplyFor(invoice.client, invoice.city.gstStateCode);
      const totals = computeTotals(
        invoice.items.map((i) => ({ qty: i.qty.toNumber(), rate: i.rate.toNumber(), discountPct: i.discountPct.toNumber(), gstRate: i.gstRate.toNumber() })),
        invoice.city.gstStateCode,
        placeOfSupply,
      );

      return tx.invoice.update({
        where: { id: invoice.id },
        data: { invoiceNo, issueDate: issuedAt, status: "ISSUED", placeOfSupply, ...totals },
        include: { items: true },
      });
    });
  }

  /**
   * Sequential, gap-free, never-reused numbering per city per financial year —
   * locked under the same transaction as the invoice update.
   *
   * Estimates run on their OWN series (…/EST-0001). They used to draw from the
   * tax-invoice counter, so every estimate burned a tax-invoice serial and
   * left a hole in the series GST Rule 46 requires to be consecutive. The
   * estimate counter is keyed "<FY>-EST" in the same table, which keeps the
   * existing (city_id, financial_year) uniqueness doing the locking.
   */
  private async mintInvoiceNumber(
    tx: Tx,
    workspaceId: string,
    cityId: string,
    cityCode: string,
    at: Date,
    docType: "TAX_INVOICE" | "ESTIMATE",
  ): Promise<string> {
    const fy = financialYearFor(at);
    const series = docType === "ESTIMATE" ? `${fy}-EST` : fy;
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO invoice_counters (id, workspace_id, city_id, financial_year, last_sequence)
                 VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, ${cityId}::uuid, ${series}, 0)
                 ON CONFLICT (city_id, financial_year) DO NOTHING`,
    );
    const [locked] = await tx.$queryRaw<Array<{ last_sequence: number }>>(
      Prisma.sql`SELECT last_sequence FROM invoice_counters WHERE city_id = ${cityId}::uuid AND financial_year = ${series} FOR UPDATE`,
    );
    const nextSeq = (locked?.last_sequence ?? 0) + 1;
    await tx.$executeRaw(
      Prisma.sql`UPDATE invoice_counters SET last_sequence = ${nextSeq} WHERE city_id = ${cityId}::uuid AND financial_year = ${series}`,
    );
    const seq = String(nextSeq).padStart(4, "0");
    return docType === "ESTIMATE" ? `AMM/${cityCode}/${fy}/EST-${seq}` : `AMM/${cityCode}/${fy}/${seq}`;
  }

  async recordPayment(user: RequestUser, invoiceId: string, input: RecordPaymentInput, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.client.payment.findUnique({ where: { idempotencyKey }, include: { invoice: true } });
      if (existing) {
        // Same key, different invoice or tenant, is a different request — not a replay.
        if (existing.invoiceId !== invoiceId || existing.invoice.workspaceId !== user.workspaceId) {
          throw new ConflictException("Idempotency key already used for a different payment.");
        }
        const { invoice: _invoice, ...payment } = existing;
        return payment;
      }
    }
    return this.prisma.client.$transaction(async (tx) => {
      const found = await tx.invoice.findFirst({ where: { id: invoiceId, workspaceId: user.workspaceId, deletedAt: null } });
      if (!found) throw new NotFoundException("Invoice not found.");
      this.cityScope.assertCanAccessCity(user, found.cityId);

      // Without the lock, two payments landing together each read the other's
      // absence and both write PARTIALLY_PAID for an invoice they paid in full.
      await lockInvoice(tx, invoiceId);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { payments: true, creditNotes: true, debitNotes: true },
      });
      if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
        throw new BadRequestException(`Cannot record a payment against a ${invoice.status} invoice.`);
      }
      if (invoice.docType === "ESTIMATE") {
        throw new BadRequestException("An estimate is not a demand for payment — issue a tax invoice and record the payment against that.");
      }

      const total = invoice.total.toNumber();
      const paid = sum(invoice.payments);
      const credited = sum(invoice.creditNotes);
      const debited = sum(invoice.debitNotes);
      const balance = outstanding(total, paid, credited, debited);
      if (balance <= 0) throw new ConflictException("This invoice is already fully paid.");
      if (input.amount > balance + 0.005) {
        throw new BadRequestException(
          `Payment of ${input.amount.toFixed(2)} exceeds the balance due of ${balance.toFixed(2)}. Record the balance, and handle any excess as a refund.`,
        );
      }

      const payment = await tx.payment.create({
        data: { invoiceId, amount: input.amount, method: input.method, receivedAt: input.receivedAt ?? new Date(), createdById: user.id, idempotencyKey },
      });

      const status = settlementStatus(invoice.status as "ISSUED", total, paid + input.amount, credited, debited);
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });

      return payment;
    });
  }

  /** Corrections to an ISSUED invoice — never an UPDATE on the invoice's amounts. */
  async createCreditNote(user: RequestUser, invoiceId: string, input: CreateAdjustmentNoteInput) {
    return this.createNote(user, invoiceId, input, "credit");
  }

  async createDebitNote(user: RequestUser, invoiceId: string, input: CreateAdjustmentNoteInput) {
    return this.createNote(user, invoiceId, input, "debit");
  }

  /**
   * A note changes what the customer owes, so the invoice's status has to
   * follow it: a credit note that clears the balance settles the invoice, and
   * a debit note on a PAID invoice re-opens it. Neither used to happen — an
   * invoice with any credit note could never reach PAID.
   */
  private async createNote(user: RequestUser, invoiceId: string, input: CreateAdjustmentNoteInput, kind: "credit" | "debit") {
    const label = kind === "credit" ? "Credit" : "Debit";
    return this.prisma.client.$transaction(async (tx) => {
      const found = await tx.invoice.findFirst({ where: { id: invoiceId, workspaceId: user.workspaceId, deletedAt: null } });
      if (!found) throw new NotFoundException("Invoice not found.");
      this.cityScope.assertCanAccessCity(user, found.cityId);
      await lockInvoice(tx, invoiceId);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { payments: true, creditNotes: true, debitNotes: true },
      });
      if (invoice.status === "DRAFT") {
        throw new BadRequestException(`${label} notes apply to issued invoices only — edit the draft directly instead.`);
      }
      if (invoice.docType === "ESTIMATE") {
        throw new BadRequestException(`${label} notes adjust tax invoices — an estimate has nothing filed to adjust.`);
      }

      const total = invoice.total.toNumber();
      const paid = sum(invoice.payments);
      let credited = sum(invoice.creditNotes);
      let debited = sum(invoice.debitNotes);
      if (kind === "credit") {
        const creditable = amountDue(total, credited, debited);
        if (input.amount > creditable + 0.005) {
          throw new BadRequestException(
            `Credit of ${input.amount.toFixed(2)} exceeds the ${creditable.toFixed(2)} still billed on this invoice.`,
          );
        }
        credited += input.amount;
      } else {
        debited += input.amount;
      }

      const data = { invoiceId, amount: input.amount, reason: input.reason, createdById: user.id };
      const note = kind === "credit" ? await tx.creditNote.create({ data }) : await tx.debitNote.create({ data });
      const status = settlementStatus(invoice.status as "ISSUED", total, paid, credited, debited);
      if (status !== invoice.status) await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
      return note;
    });
  }

  /**
   * Cancels a DRAFT invoice. DRAFT-only, deliberately: an ISSUED invoice has
   * a minted, gap-free number and is a tax document, so it is never
   * cancelled or deleted — the only correction path is a credit note (see
   * class doc). Soft-deletes rather than hard-deleting so the number
   * placeholder and the audit trail stay resolvable.
   */
  /**
   * Corrects a DRAFT invoice.
   *
   * DRAFT ONLY, for the same reason cancel() is. An issued invoice carries a
   * number from a gapless series and has been sent to a customer; changing
   * its lines afterwards would leave AMM's books and the customer's copy
   * disagreeing, with nothing recording that they ever differed. An issued
   * invoice is corrected with a credit or debit note, which is a document in
   * its own right and leaves both sides an audit trail.
   *
   * The totals are recomputed here rather than trusted from the caller, by
   * the same `computeTotals` the issue path uses — a client that sends its
   * own arithmetic is a client that can send the wrong arithmetic. The place
   * of supply is recomputed too, because changing the city changes whether
   * the invoice is CGST+SGST or IGST.
   */
  async update(user: RequestUser, id: string, input: UpdateInvoiceInput) {
    return this.prisma.client.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, workspaceId: user.workspaceId, deletedAt: null },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found.");
      this.cityScope.assertCanAccessCity(user, invoice.cityId);
      if (invoice.status !== "DRAFT") {
        throw new ConflictException(
          `Only a DRAFT invoice can be edited — this one is ${invoice.status}. An issued invoice is a tax document; ` +
            "correct it with a credit or debit note.",
        );
      }

      const cityId = input.cityId ?? invoice.cityId;
      if (input.cityId && input.cityId !== invoice.cityId) this.cityScope.assertCanAccessCity(user, input.cityId);
      const [client, city] = await Promise.all([
        tx.client.findFirst({ where: { id: invoice.clientId, workspaceId: user.workspaceId } }),
        tx.city.findFirst({ where: { id: cityId, workspaceId: user.workspaceId } }),
      ]);
      if (!client) throw new NotFoundException("Client not found.");
      if (!city) throw new NotFoundException("City not found.");
      if (input.brandId) {
        const brand = await tx.brand.findFirst({ where: { id: input.brandId, workspaceId: user.workspaceId } });
        if (!brand) throw new NotFoundException("Brand not found.");
      }

      // The lines as they will stand after this edit — the caller's if they
      // sent any, otherwise the ones already stored.
      const items =
        input.items ??
        invoice.items.map((i) => ({
          description: i.description,
          detail: i.detail ?? undefined,
          qty: i.qty.toNumber(),
          unit: i.unit ?? undefined,
          rate: i.rate.toNumber(),
          discountPct: i.discountPct.toNumber(),
          hsnSac: i.hsnSac ?? undefined,
          gstRate: i.gstRate.toNumber(),
          scope: i.scope,
        }));

      const placeOfSupply = placeOfSupplyFor(client, city.gstStateCode);
      const totals = computeTotals(items, city.gstStateCode, placeOfSupply);

      // Replace the lines wholesale. Patching them individually would make
      // the printed line numbers depend on the order edits arrived in.
      if (input.items) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
      }

      return tx.invoice.update({
        where: { id: invoice.id },
        data: {
          cityId,
          ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
          ...(input.docType !== undefined ? { docType: input.docType } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
          ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
          ...(input.quotationRef !== undefined ? { quotationRef: input.quotationRef } : {}),
          ...(input.serviceLocation !== undefined ? { serviceLocation: input.serviceLocation } : {}),
          placeOfSupply,
          ...totals,
          // No updatedById: the Invoice model has no such column. The edit is
          // recorded by @Audit("invoice", "invoice.update") on the route.
          ...(input.items
            ? {
                items: {
                  create: input.items.map((i, index) => ({
                    description: i.description,
                    detail: i.detail,
                    qty: i.qty,
                    unit: i.unit,
                    rate: i.rate,
                    discountPct: i.discountPct,
                    hsnSac: i.hsnSac,
                    gstRate: i.gstRate,
                    scope: i.scope,
                    sortOrder: index,
                  })),
                },
              }
            : {}),
        },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      });
    });
  }

  async cancel(user: RequestUser, id: string, reason?: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
      if (!invoice) throw new NotFoundException("Invoice not found.");
      this.cityScope.assertCanAccessCity(user, invoice.cityId);
      if (invoice.status !== "DRAFT") {
        throw new ConflictException(
          `Only a DRAFT invoice can be cancelled — this one is ${invoice.status}. An issued invoice is a tax ` +
            "document and is corrected with a credit note, never cancelled.",
        );
      }
      return tx.invoice.update({
        where: { id },
        data: { status: "CANCELLED", deletedAt: new Date() },
      });
    });
  }

  /**
   * Loads an invoice and renders it as a PDF. Every value on the page comes
   * from the stored row — nothing is passed in by the caller beyond the id.
   */
  /**
   * WhatsApps an issued invoice to the client.
   *
   * Refused for a draft, and refused when the client has no phone number —
   * both with the reason, because both are fixable in about a minute and a
   * generic failure would send somebody looking in the wrong place.
   *
   * The message is an approved template: WhatsApp does not allow free text
   * to somebody who has not written to you in the last 24 hours, and an
   * invoice notification is exactly the case that rule exists for.
   */
  /**
   * A link to this invoice's PDF that anyone can open — for pasting into an
   * e-mail, a WhatsApp chat, or a message to somebody in the client's
   * accounts team who is not the contact on file.
   *
   * The same signed URL the automated send uses. Exposed separately because
   * plenty of invoices go out by hand, and without this the only way to give
   * a client their PDF would be to download it and attach it.
   *
   * Drafts have no shareable link: the number is a placeholder and the GST
   * split is not final.
   */
  async shareLink(user: RequestUser, id: string) {
    const invoice = await this.get(user, id);
    if (invoice.status === "DRAFT") {
      throw new BadRequestException("A draft has no shareable link — issue it first.");
    }
    return {
      url: this.links.urlFor(invoice.id),
      invoiceNo: invoice.invoiceNo,
      expiresInDays: Number(process.env.INVOICE_LINK_TTL_DAYS ?? 90),
    };
  }

  async sendOnWhatsApp(user: RequestUser, id: string) {
    const invoice = await this.get(user, id);
    if (invoice.status === "DRAFT") {
      throw new BadRequestException("This invoice is still a DRAFT — issue it before sending it to the client.");
    }
    const to = this.whatsappConfig.toWhatsAppNumber(invoice.client.phone);
    if (!to) {
      throw new BadRequestException(`${invoice.client.name} has no usable phone number on file — add one before sending.`);
    }
    this.whatsappConfig.assertUsable();

    const balance = outstanding(
      invoice.total.toNumber(),
      sum(invoice.payments),
      sum(invoice.creditNotes),
      sum(invoice.debitNotes),
    );
    const sent = await this.whatsapp.send({
      to,
      name: invoice.client.name,
      template: process.env.WHATSAPP_INVOICE_TEMPLATE ?? "invoice_sent",
      // Fills {{1}}…{{5}} in the approved template, in this order.
      params: [
        invoice.client.name,
        invoice.invoiceNo,
        `INR ${balance.toFixed(2)}`,
        businessDateString(invoice.dueDate),
        this.links.urlFor(invoice.id),
      ],
    });
    return { ok: true as const, to, sent: sent.sent, mode: this.whatsappConfig.mode };
  }

  async renderPdf(user: RequestUser, id: string): Promise<{ buffer: Buffer; filename: string }> {
    return this.renderLoaded(await this.get(user, id));
  }

  /**
   * The same PDF, for a signed public link — no signed-in user involved.
   *
   * Authorisation has already happened: InvoiceLinkService verified an HMAC
   * that only this server could have produced for this invoice id. So the
   * lookup here is deliberately unscoped by city or permission; re-checking
   * a user who does not exist would mean inventing one, and a fabricated
   * privileged user is exactly the thing that later turns into a hole.
   *
   * Drafts are refused. A draft carries a placeholder number and no final
   * GST split — a client opening one would be reading a document that
   * matches nothing in AMM's books.
   */
  async renderPdfForLink(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.prisma.client.invoice.findFirst({
      where: { id, deletedAt: null },
      include: INVOICE_INCLUDE,
    });
    if (!invoice) throw new NotFoundException("Invoice not found.");
    if (invoice.status === "DRAFT") throw new NotFoundException("That invoice has not been issued yet.");
    return this.renderLoaded(invoice);
  }

  private async renderLoaded(invoice: Awaited<ReturnType<InvoicesService["get"]>>): Promise<{ buffer: Buffer; filename: string }> {
    // A draft renders as a clearly marked preview (see InvoicePdfService):
    // "DRAFT — NOT A TAX INVOICE", watermarked, no bank details or balance
    // due, and never its internal placeholder number.
    const draft = invoice.status === "DRAFT";
    const workspace = await this.prisma.client.workspace.findUniqueOrThrow({ where: { id: invoice.workspaceId } });
    const clientState = recipientStateCode(invoice.client);
    const stateRows = await this.prisma.client.gstStateCode.findMany({
      where: { code: { in: [invoice.placeOfSupply, clientState].filter((c): c is string => !!c) } },
    });
    const pm = await this.prisma.client.user.findUnique({ where: { id: invoice.project.pmId }, select: { name: true } });
    const stateName = (code: string | null) => (code ? stateRows.find((r) => r.code === code)?.state ?? null : null);

    const data: InvoicePdfData = {
      invoiceNo: draft ? "Draft — unnumbered" : invoice.invoiceNo,
      docType: invoice.docType,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      status: invoice.status,
      placeOfSupply: invoice.placeOfSupply,
      placeOfSupplyName: stateName(invoice.placeOfSupply),
      paymentTerms: invoice.paymentTerms,
      quotationRef: invoice.quotationRef,
      serviceLocation: invoice.serviceLocation,
      taxableAmount: invoice.taxableAmount.toNumber(),
      cgst: invoice.cgst.toNumber(),
      sgst: invoice.sgst.toNumber(),
      igst: invoice.igst.toNumber(),
      roundOff: invoice.roundOff.toNumber(),
      total: invoice.total.toNumber(),
      workspace: {
        name: workspace.name,
        gstin: workspace.gstin,
        address: workspace.address,
        website: workspace.website,
        bankName: workspace.bankName,
        bankAccountName: workspace.bankAccountName,
        bankAccountNo: workspace.bankAccountNo,
        bankIfsc: workspace.bankIfsc,
        invoiceTerms: workspace.invoiceTerms,
        invoiceDeclaration: workspace.invoiceDeclaration,
      },
      brand: invoice.brand ? { name: invoice.brand.name, tagline: invoice.brand.tagline, website: invoice.brand.website } : null,
      city: { name: invoice.city.name, state: invoice.city.state, gstStateCode: invoice.city.gstStateCode },
      client: {
        name: invoice.client.name,
        address: invoice.client.address,
        gstin: invoice.client.gstin,
        gstStateCode: clientState,
        stateName: stateName(clientState),
      },
      project: { name: invoice.project.name, eventDate: invoice.project.eventDate, ref: invoice.project.externalRef, manager: pm?.name ?? null },
      items: invoice.items.map((i) => ({
        description: i.description,
        detail: i.detail,
        qty: i.qty.toNumber(),
        unit: i.unit,
        rate: i.rate.toNumber(),
        discountPct: i.discountPct.toNumber(),
        hsnSac: i.hsnSac,
        gstRate: i.gstRate.toNumber(),
        scope: i.scope,
      })),
      payments: invoice.payments.map((p) => ({ amount: p.amount.toNumber(), receivedAt: p.receivedAt, method: p.method })),
      creditNotes: invoice.creditNotes.map((n) => ({ amount: n.amount.toNumber(), reason: n.reason })),
      debitNotes: invoice.debitNotes.map((n) => ({ amount: n.amount.toNumber(), reason: n.reason })),
    };

    const buffer = await this.pdf.render(data);
    // Invoice numbers contain slashes (AMM/JPR/26-27/0001) which are not
    // legal in a filename.
    const filename = draft
      ? `DRAFT - ${invoice.client.name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.pdf`
      : `${invoice.invoiceNo.replace(/\//g, "-")}.pdf`;
    return { buffer, filename };
  }

  /**
   * E-mails an issued invoice to the client, PDF attached. DRAFT invoices
   * are not sendable — an unissued invoice has no real number and no final
   * GST split, so sending one would put a document in a client's inbox that
   * does not correspond to anything in AMM's books.
   */
  async emailToClient(user: RequestUser, id: string) {
    const invoice = await this.get(user, id);
    if (invoice.status === "DRAFT") {
      throw new BadRequestException("This invoice is still a DRAFT — issue it before sending it to the client.");
    }
    if (!invoice.client.email) {
      throw new BadRequestException(`${invoice.client.name} has no e-mail address on file — add one before sending.`);
    }

    const { buffer, filename } = await this.renderPdf(user, id);
    const total = invoice.total.toNumber();
    const balance = outstanding(total, sum(invoice.payments), sum(invoice.creditNotes), sum(invoice.debitNotes));
    const isEstimate = invoice.docType === "ESTIMATE";

    const sent = await this.mail.send({
      to: invoice.client.email,
      subject: `${isEstimate ? "Estimate" : "Invoice"} ${invoice.invoiceNo} from AMM Brands LLP`,
      text: isEstimate
        ? `Dear ${invoice.client.name},\n\n` +
          `Please find attached estimate ${invoice.invoiceNo} for ${invoice.project.name}.\n\n` +
          `Estimated total: INR ${total.toFixed(2)}\n\n` +
          `This is an estimate, not a tax invoice — a tax invoice will follow against actuals.\n\n` +
          `AMM Brands LLP`
        : `Dear ${invoice.client.name},\n\n` +
          `Please find attached invoice ${invoice.invoiceNo} for ${invoice.project.name}.\n\n` +
          `Invoice total: INR ${total.toFixed(2)}\n` +
          `Balance due: INR ${balance.toFixed(2)}\n` +
          `Due date: ${businessDateString(invoice.dueDate)}\n\n` +
          `Please quote ${invoice.invoiceNo} in your payment reference.\n\n` +
          `AMM Brands LLP`,
      attachments: [{ filename, content: buffer, contentType: "application/pdf" }],
    });

    await this.prisma.client.auditLog.create({
      data: {
        workspaceId: user.workspaceId,
        actorId: user.id,
        action: "invoice.emailed",
        entityType: "invoice",
        entityId: id,
        after: { to: invoice.client.email, mode: sent.mode, messageId: sent.messageId },
      },
    });

    return { ok: true, to: invoice.client.email, mode: sent.mode, messageId: sent.messageId };
  }

  /**
   * Transitions ISSUED / PARTIALLY_PAID invoices past their due date to
   * OVERDUE. Run from the BullMQ worker (workers/), NOT an in-process cron —
   * with more than one API instance an in-process schedule fires once per
   * instance, and "it's idempotent so the duplicate is harmless" is a
   * mitigation, not a design.
   *
   * Deliberately NOT city-scoped and NOT permission-gated: it runs as the
   * system, over the whole workspace, with no user in the request context.
   * It is exported as a service method (rather than living in the worker) so
   * the same code path is what the e2e test drives.
   */
  async sweepOverdue(now: Date = new Date()): Promise<{ transitioned: number; invoiceIds: string[] }> {
    /**
     * TIMEZONE (found 2026-09-16 while auditing what the dormant worker owns).
     *
     * `dueDate: { lt: now }` was wrong by a day, every time. Due dates arrive
     * as `2026-09-16` and `z.coerce.date()` stores them as midnight **UTC**,
     * which is 05:30 in Jaipur — so at 06:00 IST on the very morning an
     * invoice falls due, this marked it OVERDUE and told the PM a client who
     * still had a full working day was late.
     *
     * A due date is a calendar date, not an instant. "Past due" means past the
     * end of that day where AMM works, so the comparison is made against the
     * end of the business day. Nothing about the stored value changes; only
     * the boundary it is compared to.
     */
    const cutoff = endOfBusinessDay(now);
    // endOfBusinessDay(now) is the end of TODAY in business time, so an
    // invoice due today (stored at today's business-midnight) sorts before it
    // and would still be caught. Step back a whole business day: only invoices
    // whose due date is strictly before today's business date are late.
    const lastClosedDay = new Date(cutoff.getTime() - 86_400_000);
    const due = await this.prisma.client.invoice.findMany({
      where: {
        deletedAt: null,
        // An estimate is never "overdue" — nothing on it is payable.
        docType: "TAX_INVOICE",
        status: { in: ["ISSUED", "PARTIALLY_PAID"] },
        // Every invoice whose business day has closed before `now`.
        dueDate: { lte: lastClosedDay },
      },
      include: { project: true, client: true },
    });
    if (due.length === 0) return { transitioned: 0, invoiceIds: [] };

    const transitioned: string[] = [];
    for (const invoice of due) {
      await this.prisma.client.$transaction(async (tx) => {
        // Re-read under the transaction: a payment could have landed between
        // the scan above and this write, taking the invoice to PAID. The
        // status filter in the update makes that a no-op rather than a
        // regression from PAID back to OVERDUE.
        const updated = await tx.invoice.updateMany({
          where: { id: invoice.id, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lte: lastClosedDay } },
          data: { status: "OVERDUE" },
        });
        if (updated.count === 0) return;

        transitioned.push(invoice.id);
        await tx.auditLog.create({
          data: {
            workspaceId: invoice.workspaceId,
            actorId: null, // system sweep, not a human action
            action: "invoice.marked_overdue",
            entityType: "invoice",
            entityId: invoice.id,
            after: { invoiceNo: invoice.invoiceNo, dueDate: invoice.dueDate, previousStatus: invoice.status },
          },
        });

        // Notify the project's PM. If the project has no PM there is nobody
        // specific to tell — the audit row above is still written, so the
        // transition is never silent.
        if (invoice.project.pmId) {
          await tx.notification.create({
            data: {
              workspaceId: invoice.workspaceId,
              userId: invoice.project.pmId,
              icon: "⚠",
              // Rendered in business time: toISOString() shows the UTC date,
              // which for a date stored near a day boundary is the wrong day.
              text: `Invoice ${invoice.invoiceNo} (${invoice.client.name}) is overdue — due ${businessDateString(invoice.dueDate)}.`,
              sourceType: "invoice",
              sourceId: invoice.id,
            },
          });
        }
      });
    }

    if (transitioned.length > 0) {
      this.logger.log(`Overdue sweep: ${transitioned.length} invoice(s) transitioned to OVERDUE.`);
    }
    return { transitioned: transitioned.length, invoiceIds: transitioned };
  }
}
