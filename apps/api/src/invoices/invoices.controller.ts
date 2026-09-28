import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../common/decorators/public.decorator";
import { InvoiceLinkService } from "./invoice-link.service";
import type { Response } from "express";
import { cancelInvoiceSchema, createAdjustmentNoteSchema, createInvoiceSchema, recordPaymentSchema, updateInvoiceSchema } from "@podium/shared-types";
import { Audit } from "../common/decorators/audit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequirePermissions } from "../common/decorators/require-permissions.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestUser } from "../common/types";
import { InvoicesService } from "./invoices.service";

@Controller("invoices")
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly links: InvoiceLinkService,
  ) {}

  @Get()
  @RequirePermissions("invoices:view")
  list(@CurrentUser() user: RequestUser, @Query("cityId") cityId?: string) {
    return this.invoices.list(user, cityId);
  }

  @Get(":id")
  @RequirePermissions("invoices:view")
  get(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.invoices.get(user, id);
  }

  @Post()
  @RequirePermissions("invoices:create")
  @Audit("invoice", "invoice.create_draft")
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: ReturnType<typeof createInvoiceSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.invoices.create(user, body, idempotencyKey);
  }

  /** Locks the invoice number and its GST split — irreversible; see InvoicesService class doc. */
  @Post(":id/issue")
  @RequirePermissions("invoices:edit")
  @Audit("invoice", "invoice.issue")
  issue(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.invoices.issue(user, id);
  }

  @Post(":id/payments")
  @RequirePermissions("payments:create")
  @Audit("payment", "invoice.payment_recorded")
  recordPayment(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: ReturnType<typeof recordPaymentSchema.parse>,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.invoices.recordPayment(user, id, body, idempotencyKey);
  }

  /** DRAFT-only. An issued invoice is corrected with a credit or debit note. */
  @Patch(":id")
  @RequirePermissions("invoices:edit")
  @Audit("invoice", "invoice.update")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateInvoiceSchema)) body: ReturnType<typeof updateInvoiceSchema.parse>,
  ) {
    return this.invoices.update(user, id, body);
  }

  /** DRAFT-only. An issued invoice is corrected with a credit note, never cancelled. */
  @Post(":id/cancel")
  @RequirePermissions("invoices:delete")
  @Audit("invoice", "invoice.cancel")
  cancel(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cancelInvoiceSchema)) body: ReturnType<typeof cancelInvoiceSchema.parse>,
  ) {
    return this.invoices.cancel(user, id, body.reason);
  }

  /**
   * The same PDF, opened by a client from a link — no Podium account.
   *
   * Public by necessity: the person reading it is the customer. The token is
   * the whole boundary (see InvoiceLinkService), it is checked before
   * anything is loaded, and it is scoped to this one invoice.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(":id/pdf/public")
  async publicPdf(@Param("id") id: string, @Query("token") token: string | undefined, @Res() res: Response) {
    this.links.assertValid(id, token);
    const { buffer, filename } = await this.invoices.renderPdfForLink(id);
    res.setHeader("Content-Type", "application/pdf");
    // inline, not attachment: a client tapping a WhatsApp link expects the
    // invoice to open, not to land in their downloads folder.
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  /**
   * Sends an issued invoice to the client on WhatsApp, as an approved
   * template carrying a link to the PDF.
   */
  /** A signed, shareable link to the PDF — for sending by hand. */
  @Get(":id/share-link")
  @RequirePermissions("invoices:view")
  shareLink(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.invoices.shareLink(user, id);
  }

  @Post(":id/whatsapp")
  @RequirePermissions("invoices:edit")
  @Audit("invoice", "invoice.whatsapp")
  whatsapp(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.invoices.sendOnWhatsApp(user, id);
  }

  /**
   * Streams the invoice as a PDF rendered server-side from the stored row.
   * Permission-gated identically to reading the invoice itself.
   */
  @Get(":id/pdf")
  @RequirePermissions("invoices:view")
  async pdf(@CurrentUser() user: RequestUser, @Param("id") id: string, @Res() res: Response) {
    const { buffer, filename } = await this.invoices.renderPdf(user, id);
    res.setHeader("Content-Type", "application/pdf");
    // RFC 5987: a client's name can carry spaces or non-ASCII characters.
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  }

  /** E-mails the issued invoice with its PDF attached. Refuses on DRAFT. */
  @Post(":id/email")
  @RequirePermissions("invoices:edit")
  @Audit("invoice", "invoice.email_requested")
  email(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.invoices.emailToClient(user, id);
  }

  @Post(":id/credit-notes")
  @RequirePermissions("invoices:edit")
  @Audit("credit_note", "invoice.credit_note")
  creditNote(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(createAdjustmentNoteSchema)) body: ReturnType<typeof createAdjustmentNoteSchema.parse>) {
    return this.invoices.createCreditNote(user, id, body);
  }

  @Post(":id/debit-notes")
  @RequirePermissions("invoices:edit")
  @Audit("debit_note", "invoice.debit_note")
  debitNote(@CurrentUser() user: RequestUser, @Param("id") id: string, @Body(new ZodValidationPipe(createAdjustmentNoteSchema)) body: ReturnType<typeof createAdjustmentNoteSchema.parse>) {
    return this.invoices.createDebitNote(user, id, body);
  }
}
