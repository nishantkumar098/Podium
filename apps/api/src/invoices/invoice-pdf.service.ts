import { Injectable } from "@nestjs/common";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { amountInWords } from "./amount-in-words";
import { taxByRate } from "./invoice-math";

/**
 * The exact shape this renderer needs. Declared explicitly rather than
 * reusing a Prisma type so it is obvious at a glance that every value on the
 * page comes from a stored invoice row — never from a request body. A
 * client-supplied total on a tax document would be a forgery vector, so the
 * caller must load the invoice from the database and hand it over whole.
 */
export interface InvoicePdfData {
  invoiceNo: string;
  docType: "TAX_INVOICE" | "ESTIMATE";
  issueDate: Date | null;
  dueDate: Date;
  status: string;
  placeOfSupply: string;
  /** State name for `placeOfSupply` — GST Rule 46 wants the state, not just its code. */
  placeOfSupplyName: string | null;
  paymentTerms: string | null;
  quotationRef: string | null;
  serviceLocation: string | null;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  workspace: {
    name: string;
    gstin: string | null;
    address: string | null;
    website: string | null;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNo: string | null;
    bankIfsc: string | null;
    invoiceTerms: string[];
    invoiceDeclaration: string | null;
  };
  brand: { name: string; tagline: string | null; website: string | null } | null;
  city: { name: string; state: string; gstStateCode: string };
  /** `gstStateCode`/`stateName` are the RECIPIENT's state, null when no record says it. */
  client: { name: string; address: string | null; gstin: string | null; gstStateCode: string | null; stateName: string | null };
  /** `ref` is the project's reference on AMM's calendar; `manager` its PM. */
  project: { name: string; eventDate: Date | null; ref?: string | null; manager?: string | null };
  items: Array<{
    description: string;
    detail: string | null;
    qty: number;
    unit: string | null;
    rate: number;
    discountPct: number;
    hsnSac: string | null;
    /** GST rate as a fraction (0.18). */
    gstRate: number;
    scope: "FIXED" | "VARIABLE";
  }>;
  payments: Array<{ amount: number; receivedAt: Date; method: string }>;
  creditNotes: Array<{ amount: number; reason: string }>;
  debitNotes: Array<{ amount: number; reason: string }>;
}

const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => INR.format(n);
/** 0.09 -> "9%", 0.025 -> "2.5%". */
const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

// Business time, not UTC: an invoice issued at 01:00 IST is dated that day,
// not the day before. Date-only fields (due, event) are stored at UTC
// midnight, which is 05:30 the same calendar day in IST, so they read the same.
const date = (d: Date | null) =>
  d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).replace("Sept", "Sep") : "—";

const stateLabel = (name: string | null, code: string | null) => (code ? (name ? `${name} (${code})` : code) : "—");

const DRAFT_RED = "#b3261e";
/** A draft is a preview: provisional figures, no number, not a tax document. */
const isDraft = (d: InvoicePdfData) => d.status === "DRAFT";

// ------------------------------------------------------------------ design
// Measured off the invoice AMM supplied (AMM Brands Tax invoice.pdf).
const INK = "#1c1c1c";
const BODY = "#3a3a3a";
const MUTED = "#8c8c8c";
const FAINT = "#a3a3a3";
const RULE = "#e2ded7";
const FRAME = "#d9d5ce";
const GOLD = "#9b7a3d";
const PANEL = "#f6f3f1";
const CREAM = "#fdf4e3";
const CREAM_EDGE = "#c9a45e";

const ASSETS = join(__dirname, "assets");
const asset = (f: string) => {
  const p = join(ASSETS, f);
  return existsSync(p) ? p : null;
};

/**
 * The supplied invoice is set in Lora (text and figures) and Cormorant
 * Garamond Light (title, amounts, labels). Both ship as npm packages so they
 * travel with the API build. If a font file cannot be found the renderer
 * falls back to pdfkit's built-in faces rather than failing — an invoice that
 * renders in Times is better than no invoice at all.
 */
function fontFile(pkg: string, file: string): string | null {
  try {
    return require.resolve(`@fontsource/${pkg}/files/${file}`);
  } catch {
    return null;
  }
}
const FONT_FILES = {
  lora: fontFile("lora", "lora-latin-400-normal.woff"),
  loraMedium: fontFile("lora", "lora-latin-500-normal.woff"),
  loraItalic: fontFile("lora", "lora-latin-400-italic.woff"),
  corm: fontFile("cormorant-garamond", "cormorant-garamond-latin-300-normal.woff"),
  cormSemi: fontFile("cormorant-garamond", "cormorant-garamond-latin-600-normal.woff"),
  /** latin-ext is the subset that carries U+20B9, the rupee sign. */
  cormRupee: fontFile("cormorant-garamond", "cormorant-garamond-latin-ext-300-normal.woff"),
};

type Face = "text" | "medium" | "italic" | "display" | "displaySemi";

/**
 * One line's arithmetic, in one place. The printed document shows rate,
 * discount and taxable value as separate columns, and they must agree: doing
 * this per-column at draw time is how a PDF ends up with a discount that does
 * not reconcile against its own total.
 */
function lineMaths(item: InvoicePdfData["items"][number]) {
  const gross = item.qty * item.rate;
  const discount = gross * (item.discountPct / 100);
  const taxable = gross - discount;
  return { gross, discount, taxable };
}

/**
 * Server-side invoice PDF rendering with pdfkit — a pure-Node PDF writer, no
 * headless browser on the critical path of issuing an invoice.
 *
 * The layout reproduces the invoice AMM supplied, top to bottom: logo
 * letterhead with the spaced title, the bill-to / service-location /
 * amount-payable band, the metadata grid, line items in FIXED and VARIABLE
 * scope sections, then on the second page the tax summary, amount in words,
 * summary with balance due, bank details with scan-to-pay, terms, declaration
 * and signatures, with the brand-mark footer on every page.
 *
 * TAX_INVOICE and ESTIMATE share this one layout (the two supplied PDFs are
 * identical). Only what is legally load-bearing differs: the title and the
 * estimate's declaration that it is not a tax document.
 */
const ESTIMATE_DECLARATION =
  "This is an estimate, not a tax invoice. Quantities, scope and taxes are indicative and " +
  "will be confirmed against actuals on the event date. No input tax credit may be claimed against this document.";

@Injectable()
export class InvoicePdfService {
  render(data: InvoicePdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      try {
        this.registerFonts(doc);
        this.draw(doc, data);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private readonly left = 36;
  private readonly right = 559;
  private hasRupee = false;
  private faces: Record<Face, string> = { text: "Times-Roman", medium: "Times-Bold", italic: "Times-Italic", display: "Times-Roman", displaySemi: "Times-Bold" };

  private registerFonts(doc: PDFKit.PDFDocument): void {
    const f = FONT_FILES;
    const reg = (name: string, file: string | null, fallback: string) => {
      if (!file) return fallback;
      try {
        doc.registerFont(name, file);
        return name;
      } catch {
        return fallback;
      }
    };
    this.faces = {
      text: reg("Lora", f.lora, "Times-Roman"),
      medium: reg("Lora-Medium", f.loraMedium, "Times-Bold"),
      italic: reg("Lora-Italic", f.loraItalic, "Times-Italic"),
      display: reg("Cormorant", f.corm, "Times-Roman"),
      displaySemi: reg("Cormorant-SemiBold", f.cormSemi, "Times-Bold"),
    };
    this.hasRupee = reg("Cormorant-Rupee", f.cormRupee, "") !== "";
  }

  private font(doc: PDFKit.PDFDocument, face: Face, size: number, color: string): PDFKit.PDFDocument {
    return doc.font(this.faces[face]).fontSize(size).fillColor(color);
  }

  /** Spaced small-caps label in gold — "BILL TO", "SUMMARY". */
  private label(doc: PDFKit.PDFDocument, s: string, x: number, y: number, width: number, color = GOLD): void {
    this.font(doc, "text", 6.3, color).text(s.toUpperCase(), x, y, { width, characterSpacing: 1.6, lineBreak: false });
  }

  /**
   * "₹ 3,10,871.00" in Cormorant. The rupee sign lives in the latin-ext
   * subset and the figures in latin, so it is drawn in two runs. Without the
   * font the sign becomes "INR" rather than a stray glyph.
   */
  private rupee(doc: PDFKit.PDFDocument, amount: number, x: number, y: number, size: number, opts: { width?: number; align?: "left" | "right"; face?: Face; spacing?: number } = {}): void {
    const face = opts.face ?? "display";
    const spacing = opts.spacing ?? 0.5;
    const figures = money(amount);
    const sign = this.hasRupee ? "₹ " : "INR ";
    doc.fontSize(size);
    doc.font(this.hasRupee ? "Cormorant-Rupee" : this.faces[face]);
    const signW = doc.widthOfString(sign);
    doc.font(this.faces[face]);
    const figW = doc.widthOfString(figures, { characterSpacing: spacing });
    const startX = opts.align === "right" && opts.width ? x + opts.width - signW - figW : x;
    doc.font(this.hasRupee ? "Cormorant-Rupee" : this.faces[face]).fillColor(INK).text(sign, startX, y, { lineBreak: false });
    doc.font(this.faces[face]).fillColor(INK).text(figures, startX + signW, y, { lineBreak: false, characterSpacing: spacing });
  }

  private title(d: InvoicePdfData): string {
    if (isDraft(d)) return d.docType === "ESTIMATE" ? "DRAFT ESTIMATE" : "DRAFT INVOICE";
    return d.docType === "ESTIMATE" ? "ESTIMATE" : "TAX INVOICE";
  }

  // ---------------------------------------------------------------- header
  private letterhead(doc: PDFKit.PDFDocument, d: InvoicePdfData): number {
    const { left, right } = this;
    const logo = asset("amm-logo.png") ?? (existsSync(join(__dirname, "..", "letters", "assets", "amm-logo.png")) ? join(__dirname, "..", "letters", "assets", "amm-logo.png") : null);
    const logoW = 100;
    const top = 16;
    let y = top;
    if (logo) {
      doc.image(logo, left, y, { width: logoW });
      y += (logoW * 544) / 1171 + 5;
    } else {
      this.font(doc, "display", 16, INK).text(d.workspace.name.toUpperCase(), left, y, { characterSpacing: 1.5 });
      y = doc.y + 4;
    }
    const identity = [d.workspace.address, d.workspace.gstin ? `GSTIN ${d.workspace.gstin}` : null, d.workspace.website].filter(Boolean).join(" · ");
    this.font(doc, "text", 6.4, BODY).text(identity, left, y, { width: 250, lineGap: 1.5 });
    const leftBottom = doc.y;

    this.font(doc, "display", 21, INK).text(this.title(d), left, 40, { width: right - left, align: "right", characterSpacing: 4.2, lineBreak: false });
    const sub = d.issueDate ? `${d.invoiceNo}  ·  ${date(d.issueDate)}` : d.invoiceNo;
    this.font(doc, "text", 7, MUTED).text(sub, left, 64, { width: right - left, align: "right", characterSpacing: 1.1, lineBreak: false });
    if (isDraft(d)) {
      this.font(doc, "text", 6.3, DRAFT_RED).text("NOT A TAX INVOICE — FOR REVIEW ONLY", left, 78, { width: right - left, align: "right", characterSpacing: 1.6, lineBreak: false });
    } else if (d.docType === "TAX_INVOICE") {
      // A GST tax-invoice copy marker (Rule 48); on an estimate it would mislead.
      this.font(doc, "text", 6.3, GOLD).text("ORIGINAL FOR RECIPIENT", left, 78, { width: right - left, align: "right", characterSpacing: 1.6, lineBreak: false });
    }

    const bottom = Math.max(leftBottom + 5, 90);
    // Full-bleed rule, edge to edge, as on the supplied invoice.
    doc.moveTo(0, bottom).lineTo(doc.page.width, bottom).lineWidth(1.8).strokeColor(INK).stroke();
    return bottom + 20;
  }

  private draw(doc: PDFKit.PDFDocument, d: InvoicePdfData): void {
    const { left, right } = this;
    const width = right - left;
    let y = this.letterhead(doc, d);

    // The balance a customer actually owes: the invoice total, less what they
    // have paid, less any credit note, plus any debit note. Credit and debit
    // notes never alter the issued invoice row (it is immutable), so this is
    // the only place the net position is expressed.
    const paid = d.payments.reduce((s, p) => s + p.amount, 0);
    const credited = d.creditNotes.reduce((s, n) => s + n.amount, 0);
    const debited = d.debitNotes.reduce((s, n) => s + n.amount, 0);
    const balance = d.total - paid - credited + debited;

    // ------------------------------------- bill to / service / amount band
    const colW = width / 3;
    const pad = 10;
    const boxTop = y;
    const bandTop = y + 13;
    const kv = (k: string, v: string, x: number, yy: number, w: number): number => {
      this.font(doc, "text", 6.6, MUTED).text(k, x, yy, { width: 44, lineBreak: false });
      this.font(doc, "text", 6.6, INK).text(v, x + 44, yy, { width: w - 44 });
      return doc.y + 2.5;
    };

    // Bill to
    let c1 = left + pad;
    this.label(doc, "Bill to", c1, bandTop, colW - 2 * pad);
    this.font(doc, "text", 9.6, INK).text(d.client.name, c1, bandTop + 15, { width: colW - 2 * pad, lineGap: 1 });
    this.font(doc, "text", 6.6, BODY).text(d.client.address ?? "Billing address as per client records", c1, doc.y + 3, { width: colW - 2 * pad });
    let yy = doc.y + 5;
    // The recipient's state — never the billing branch's.
    yy = kv("GSTIN / UIN", d.client.gstin ?? "—", c1, yy, colW - 2 * pad);
    yy = kv("State", stateLabel(d.client.stateName, d.client.gstStateCode), c1, yy, colW - 2 * pad);
    const c1Bottom = yy;

    // Service location
    c1 = left + colW + pad;
    this.label(doc, "Service location", c1, bandTop, colW - 2 * pad);
    this.font(doc, "text", 10, INK).text(d.serviceLocation ?? d.city.name, c1, bandTop + 15, { width: colW - 2 * pad });
    yy = doc.y + 5;
    yy = kv("Event", d.project.name, c1, yy, colW - 2 * pad);
    yy = kv("Event date", date(d.project.eventDate), c1, yy, colW - 2 * pad);
    if (d.project.ref) yy = kv("Project ID", d.project.ref, c1, yy, colW - 2 * pad);
    const c2Bottom = yy;

    // Amount payable
    c1 = left + colW * 2 + pad;
    this.label(doc, isDraft(d) ? "Draft total" : d.docType === "ESTIMATE" ? "Estimated total" : "Amount payable", c1, bandTop, colW - 2 * pad);
    this.rupee(doc, d.docType === "ESTIMATE" || isDraft(d) ? d.total : balance, c1, bandTop + 13, 20, { spacing: 0.8 });
    const note = isDraft(d) ? "Provisional — figures lock when issued" : d.docType === "ESTIMATE" ? `Valid until ${date(d.dueDate)}` : `Balance due by ${date(d.dueDate)}`;
    this.font(doc, "text", 6.6, BODY).text(note, c1, bandTop + 40, { width: colW - 2 * pad });
    let c3Bottom = doc.y;
    if (d.docType === "TAX_INVOICE" && !isDraft(d)) {
      const status = d.status.replace(/_/g, " ");
      this.font(doc, "text", 5.8, GOLD);
      const pillW = doc.widthOfString(status, { characterSpacing: 1.4 }) + 20;
      const pillY = doc.y + 7;
      doc.rect(c1, pillY, pillW, 15).lineWidth(0.8).strokeColor(CREAM_EDGE).stroke();
      this.font(doc, "text", 5.8, GOLD).text(status, c1, pillY + 4.8, { width: pillW, align: "center", characterSpacing: 1.4, lineBreak: false });
      c3Bottom = pillY + 15;
    }

    y = Math.max(c1Bottom, c2Bottom, c3Bottom) + 7;
    doc.rect(left, boxTop, width, y - boxTop).lineWidth(0.7).strokeColor(FRAME).stroke();
    doc.moveTo(left + colW, boxTop).lineTo(left + colW, y).stroke();
    doc.moveTo(left + colW * 2, boxTop).lineTo(left + colW * 2, y).stroke();

    // --------------------------------------------------------- metadata grid
    // "Label value" inline in each cell, as on the supplied invoice.
    const meta: Array<[string, string]> = [
      [d.docType === "ESTIMATE" ? "Estimate no." : "Invoice no.", d.invoiceNo],
      [d.docType === "ESTIMATE" ? "Estimate date" : "Invoice date", date(d.issueDate)],
      [d.docType === "ESTIMATE" ? "Valid until" : "Due date", date(d.dueDate)],
      ["Payment terms", d.paymentTerms ?? "—"],
      ["Place of supply", stateLabel(d.placeOfSupplyName, d.placeOfSupply)],
      ["Reverse charge", "No"],
      ["Quotation ref.", d.quotationRef ?? "—"],
      ["Account manager", d.project.manager ?? "—"],
    ];
    const cellW = width / 4;
    for (let row = 0; row < 2; row += 1) {
      let rowH = 30;
      const cells = meta.slice(row * 4, row * 4 + 4);
      // Measure first so a wrapped value grows the whole row.
      cells.forEach(([k, v]) => {
        this.font(doc, "text", 6.8, MUTED);
        const h = doc.heightOfString(`${k} ${v}`, { width: cellW - 20, lineGap: 2.5 });
        rowH = Math.max(rowH, h + 7);
      });
      cells.forEach(([k, v], col) => {
        const x = left + col * cellW;
        doc.rect(x, y, cellW, rowH).lineWidth(0.7).strokeColor(FRAME).stroke();
        this.font(doc, "text", 6.8, MUTED).text(`${k} `, x + 10, y + 9, { width: cellW - 20, continued: true, lineGap: 2.5 });
        doc.fillColor(INK).text(v, { lineGap: 2.5 });
      });
      y += rowH;
    }
    y += 14;

    // ----------------------------------------------------------- line items
    const intraState = d.igst <= 0;
    // One rate on every line (the usual case) keeps the stored totals as the
    // printed figures. Mixed rates are banded per rate, using the same rule
    // the totals were computed with.
    const rates = [...new Set(d.items.map((i) => i.gstRate))].sort((a, b) => b - a);
    const singleRate = rates.length === 1 ? rates[0]! : null;
    const bands =
      singleRate !== null
        ? [{ rate: singleRate, taxable: d.taxableAmount, cgst: d.cgst, sgst: d.sgst, igst: d.igst }]
        : taxByRate(d.items, "S", intraState ? "S" : "X");
    const bandTaxable = new Map(bands.map((b) => [b.rate, d.items.filter((i) => i.gstRate === b.rate).reduce((sum, i) => sum + lineMaths(i).taxable, 0)]));

    // Right edges of each numeric column, measured off the supplied invoice.
    const R = { qty: 281, rate: 334, disc: 356, taxable: 416, t1: 459, t2: 504, total: right };
    const X = { n: left, desc: left + 17, hsn: 220 };
    const descW = X.hsn - X.desc - 8;
    const num = (s: string, rightEdge: number, yy2: number, w: number, face: Face = "text", color = BODY) =>
      this.font(doc, face, 7.3, color).text(s, rightEdge - w, yy2, { width: w, align: "right", characterSpacing: 0.3, lineBreak: false });

    const header = (top: number): number => {
      const h = 30;
      doc.rect(left, top, width, h).fill(PANEL);
      doc.moveTo(left, top).lineTo(right, top).lineWidth(1.6).strokeColor(INK).stroke();
      doc.moveTo(left, top + h).lineTo(right, top + h).lineWidth(0.9).strokeColor(INK).stroke();
      const ty = top + 9;
      const hd = (s: string, x: number, w: number, align: "left" | "right" = "left") =>
        this.font(doc, "text", 5.9, BODY).text(s, x, ty, { width: w, align, characterSpacing: 1.2, lineGap: 1.5 });
      hd("#", X.n, 12);
      hd("DESCRIPTION OF SERVICE / GOODS", X.desc, descW + 10);
      hd("HSN\nSAC", X.hsn, 26);
      hd("QTY", R.qty - 40, 40, "right");
      hd("RATE", R.rate - 48, 44, "right");
      hd("DISC.", R.disc - 22, 22, "right");
      hd("TAXABLE\nVALUE", R.taxable - 50, 50, "right");
      if (intraState) {
        hd(singleRate !== null ? `CGST\n${pct(singleRate / 2)}` : "CGST", R.t1 - 40, 40, "right");
        hd(singleRate !== null ? `SGST\n${pct(singleRate / 2)}` : "SGST", R.t2 - 40, 40, "right");
      } else {
        hd(singleRate !== null ? `IGST\n${pct(singleRate)}` : "IGST", R.t2 - 60, 60, "right");
      }
      hd("TOTAL", R.total - 50, 50, "right");
      return top + h + 11;
    };

    y = header(y);

    // An invoice with nothing billed on actuals simply has no VARIABLE
    // heading — an empty section would imply something to look for.
    const sections: Array<[string, InvoicePdfData["items"]]> = [
      ["FIXED SCOPE — CONTRACTED RATES", d.items.filter((i) => i.scope === "FIXED")],
      ["VARIABLE SCOPE — BILLED ON ACTUALS", d.items.filter((i) => i.scope === "VARIABLE")],
    ];

    // Tax is apportioned per line from the stored totals rather than
    // recomputed: the stored figures are what was filed, and a renderer that
    // arrives at its own numbers can disagree with the return.
    const bandOf = (rate: number) => bands.find((b) => b.rate === rate)!;
    const share = (rate: number, taxable: number, pot: number) => {
      const base = bandTaxable.get(rate) ?? 0;
      return base > 0 ? (taxable / base) * pot : 0;
    };

    const PAGE_BOTTOM = 772;
    let n = 0;
    for (const [heading, items] of sections) {
      if (items.length === 0) continue;
      if (y > PAGE_BOTTOM - 50) {
        doc.addPage();
        y = header(this.letterhead(doc, d));
      }
      this.label(doc, heading, X.n, y, width);
      y += 15;

      for (const item of items) {
        n += 1;
        const { taxable } = lineMaths(item);
        const band = bandOf(item.gstRate);
        const t1 = intraState ? share(item.gstRate, taxable, band.cgst) : share(item.gstRate, taxable, band.igst);
        const t2 = intraState ? share(item.gstRate, taxable, band.sgst) : 0;
        const lineTotal = taxable + t1 + t2;

        const descH = this.font(doc, "text", 8.2, INK).heightOfString(item.description, { width: descW });
        const detailH = item.detail ? this.font(doc, "italic", 5.9, FAINT).heightOfString(item.detail, { width: descW, lineGap: 1.6 }) + 2.5 : 0;
        const rowH = Math.max(descH + detailH, 12) + 8;

        if (y + rowH > PAGE_BOTTOM) {
          doc.addPage();
          y = header(this.letterhead(doc, d));
        }

        const ty = y;
        this.font(doc, "text", 7.3, FAINT).text(String(n).padStart(2, "0"), X.n, ty + 0.5, { width: 14, characterSpacing: 0.5, lineBreak: false });
        this.font(doc, "text", 8.2, INK).text(item.description, X.desc, ty, { width: descW });
        if (item.detail) this.font(doc, "italic", 5.9, FAINT).text(item.detail, X.desc, doc.y + 2.5, { width: descW, lineGap: 1.6 });

        const ny = ty + 0.5;
        this.font(doc, "text", 7.3, BODY).text(item.hsnSac ?? "—", X.hsn, ny, { width: 28, characterSpacing: 0.3, lineBreak: false });
        num(`${Number(item.qty.toFixed(3))}${item.unit ? ` ${item.unit}` : ""}`, R.qty, ny, 56);
        num(money(item.rate), R.rate, ny, 52);
        num(item.discountPct > 0 ? `${item.discountPct}%` : "—", R.disc, ny, 22);
        num(money(taxable), R.taxable, ny, 58);
        if (intraState) {
          num(money(t1), R.t1, ny, 43);
          num(money(t2), R.t2, ny, 43);
        } else {
          num(money(t1), R.t2, ny, 80);
        }
        num(money(lineTotal), R.total, ny, 54, "medium", INK);

        y += rowH;
        doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.6).strokeColor(RULE).stroke();
      }
      y += 5;
    }

    // ------------------------------------------------- summary (second page)
    doc.addPage();
    y = this.letterhead(doc, d);

    const halfL = 254; // tax summary / words column
    const rightX = 306;
    const halfR = right - rightX;
    const summaryTop = y;

    // --- tax summary table (left)
    this.label(doc, "Tax summary", left, y, halfL);
    y += 18;
    const taxHead = intraState ? ["Rate", "Taxable amt.", "CGST", "SGST", "Total tax"] : ["Rate", "Taxable amt.", "IGST", "Total tax"];
    const taxRight = intraState ? [left + 30, left + 88, left + 142, left + 198, left + halfL] : [left + 30, left + 120, left + 190, left + halfL];
    const taxRows = bands.map((b) =>
      intraState
        ? [pct(b.rate), money(b.taxable), money(b.cgst), money(b.sgst), money(b.cgst + b.sgst)]
        : [pct(b.rate), money(b.taxable), money(b.igst), money(b.igst)],
    );
    taxHead.forEach((h, i) =>
      i === 0
        ? this.font(doc, "text", 6.6, MUTED).text(h, left, y, { lineBreak: false })
        : this.font(doc, "text", 6.6, MUTED).text(h, taxRight[i]! - 70, y, { width: 70, align: "right", lineBreak: false }),
    );
    y += 12;
    doc.moveTo(left, y).lineTo(left + halfL, y).lineWidth(0.9).strokeColor(FRAME).stroke();
    y += 7;
    for (const row of taxRows) {
      row.forEach((v, i) =>
        i === 0
          ? this.font(doc, "text", 7.3, INK).text(v, left, y, { lineBreak: false })
          : this.font(doc, "text", 7.3, INK).text(v, taxRight[i]! - 70, y, { width: 70, align: "right", characterSpacing: 0.3, lineBreak: false }),
      );
      y += 12;
      doc.moveTo(left, y - 2).lineTo(left + halfL, y - 2).lineWidth(0.6).strokeColor(RULE).stroke();
    }
    y += 12;

    // --- amount in words (left)
    const wordsTop = y;
    this.font(doc, "display", 11, INK);
    const wordsH = doc.heightOfString(amountInWords(d.total), { width: halfL - 20, lineGap: 1.5 });
    const boxH = wordsH + 34;
    doc.lineWidth(0.7).rect(left, wordsTop, halfL, boxH).fillAndStroke(PANEL, FRAME);
    this.label(doc, "Total amount payable — in words", left + 10, wordsTop + 11, halfL - 20, MUTED);
    this.font(doc, "display", 11, INK).text(amountInWords(d.total), left + 10, wordsTop + 23, { width: halfL - 20, lineGap: 1.5 });
    const wordsBottom = wordsTop + boxH;

    // --- summary column (right)
    let sy = summaryTop;
    this.label(doc, "Summary", rightX, sy, halfR);
    sy += 17;
    const gross = d.items.reduce((s, i) => s + lineMaths(i).gross, 0);
    const discount = d.items.reduce((s, i) => s + lineMaths(i).discount, 0);
    const line = (k: string, v: string) => {
      this.font(doc, "text", 7.6, BODY).text(k, rightX, sy + 5, { width: halfR - 110, lineBreak: false });
      this.font(doc, "text", 7.6, INK).text(v, right - 110, sy + 5, { width: 110, align: "right", characterSpacing: 0.3, lineBreak: false });
      sy += 20.3;
      doc.moveTo(rightX, sy).lineTo(right, sy).lineWidth(0.6).strokeColor(RULE).stroke();
    };
    line("Gross amount", money(gross));
    if (discount > 0) line("Less: discount", `− ${money(discount)}`);
    line("Taxable value", money(d.taxableAmount));
    if (intraState) {
      line(singleRate !== null ? `CGST @ ${pct(singleRate / 2)}` : "CGST", money(d.cgst));
      line(singleRate !== null ? `SGST @ ${pct(singleRate / 2)}` : "SGST", money(d.sgst));
    } else {
      line(singleRate !== null ? `IGST @ ${pct(singleRate)}` : "IGST", money(d.igst));
    }
    line("Round off", `${d.roundOff < 0 ? "−" : "+"} ${money(Math.abs(d.roundOff))}`);
    sy += 12;
    this.font(doc, "text", 8.6, INK).text(d.docType === "ESTIMATE" ? "ESTIMATED TOTAL" : "GRAND TOTAL", rightX, sy + 6, { characterSpacing: 2, lineBreak: false });
    this.rupee(doc, d.total, rightX, sy, 17, { width: halfR, align: "right", spacing: 0.8 });
    sy += 23;
    doc.moveTo(rightX, sy).lineTo(right, sy).lineWidth(1.8).strokeColor(INK).stroke();

    if (!isDraft(d)) {
      if (paid > 0) {
        const pctPaid = Math.round((paid / d.total) * 100);
        line(`Advance received${pctPaid > 0 && pctPaid < 100 ? ` (${pctPaid}%)` : ""}`, `− ${money(paid)}`);
      }
      if (credited > 0) line("Credit notes", `− ${money(credited)}`);
      if (debited > 0) line("Debit notes", `+ ${money(debited)}`);
      sy += 7;
      doc.lineWidth(0.8).rect(rightX, sy, halfR, 31).fillAndStroke(CREAM, CREAM_EDGE);
      this.label(doc, "Balance due", rightX + 9, sy + 12.5, 120);
      this.rupee(doc, balance, rightX, sy + 7, 15, { width: halfR - 9, align: "right", spacing: 0.8 });
      sy += 31;
    }

    y = Math.max(wordsBottom, sy) + 21;

    // --- bank details + scan to pay. Only when configured: an invoice
    //     showing "Bank name —" invites a customer to pay into nothing. A
    //     draft invites no payment at all.
    const qr = asset("pay-qr.jpg");
    if (!isDraft(d) && d.workspace.bankName) {
      const bankW = 291;
      this.label(doc, "Bank details for payment", left, y, bankW);
      const rows = [
        ["Bank name", d.workspace.bankName],
        ["A/c holder", d.workspace.bankAccountName],
        ["A/c number", d.workspace.bankAccountNo],
        ["IFSC code", d.workspace.bankIfsc],
      ].filter((r): r is [string, string] => !!r[1]);
      const boxTop2 = y + 10;
      const bh = rows.length * 14 + 14;
      doc.rect(left, boxTop2, bankW, bh).lineWidth(0.7).strokeColor(FRAME).stroke();
      let by = boxTop2 + 9;
      for (const [k, v] of rows) {
        this.font(doc, "text", 7, MUTED).text(k, left + 10, by, { width: 54, lineBreak: false });
        this.font(doc, "text", 7.3, INK).text(v, left + 64, by, { width: bankW - 74, characterSpacing: 0.3, lineBreak: false });
        by += 14;
      }
      this.font(doc, "italic", 5.9, FAINT).text(
        `Please quote ${d.docType === "ESTIMATE" ? "estimate" : "invoice"} no. ${d.invoiceNo} in the payment reference. Cheques and transfers in favour of ${d.workspace.name}.`,
        left,
        boxTop2 + bh + 8,
        { width: bankW, lineGap: 2 },
      );
      let blockBottom = doc.y;

      if (qr) {
        const qx = 344;
        const qs = 55;
        doc.rect(qx, y - 4, qs, qs).lineWidth(0.7).strokeColor(FRAME).stroke();
        doc.image(qr, qx + 3, y - 1, { width: qs - 6, height: qs - 6 });
        this.label(doc, "Scan to pay", qx + qs + 9, y, 150);
        this.font(doc, "text", 6.4, BODY).text(
          `Scan with any UPI or banking app to pay ${d.workspace.name}. Confirm the beneficiary name before transferring.`,
          qx + qs + 9,
          y + 13,
          { width: right - (qx + qs + 9), lineGap: 2 },
        );
        blockBottom = Math.max(blockBottom, y - 4 + qs, doc.y);
      }
      y = blockBottom + 20;
    }

    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.9).strokeColor(FRAME).stroke();
    y += 14;
    const termsTop = y;
    const termsW = 293;

    // --- terms + declaration (left)
    if (d.workspace.invoiceTerms.length > 0) {
      this.label(doc, "Terms & conditions", left, y, termsW);
      let ty = y + 16;
      d.workspace.invoiceTerms.forEach((term, i) => {
        this.font(doc, "text", 7.3, BODY).text(`${i + 1}.`, left + 2, ty, { width: 10, lineBreak: false });
        this.font(doc, "text", 7.3, BODY).text(term, left + 11, ty, { width: termsW - 11, lineGap: 2.2 });
        ty = doc.y + 1.5;
      });
      y = ty + 8;
    }
    const declaration = d.docType === "ESTIMATE" ? ESTIMATE_DECLARATION : d.workspace.invoiceDeclaration;
    if (declaration) {
      this.font(doc, "text", 6.3, MUTED).text("DECLARATION  ", left, y, { width: termsW, continued: true, characterSpacing: 1.6, lineGap: 2.2 });
      this.font(doc, "text", 6.8, BODY).text(`  ${declaration}`, { characterSpacing: 0, lineGap: 2.2 });
      y = doc.y;
    }

    // --- signatures (right)
    this.font(doc, "text", 6.6, BODY).text("Receiver's signature", 344, termsTop, { width: right - 344, lineBreak: false });
    const sigRule = Math.max(y - 22, termsTop + 110);
    doc.moveTo(344, sigRule).lineTo(right, sigRule).lineWidth(1).strokeColor(INK).stroke();
    this.font(doc, "text", 7.3, INK).text(`For ${d.workspace.name}`, 344, sigRule + 6, { width: right - 344, align: "right", lineBreak: false });
    this.font(doc, "text", 6.4, MUTED).text("Authorised signatory", 344, sigRule + 18, { width: right - 344, align: "right", lineBreak: false });

    // ------------------------------------------------------------- footers
    // The footer sits inside the bottom margin. Writing there with the margin
    // in force makes pdfkit auto-insert a page per text call; zeroing the
    // margin while drawing it is pdfkit's supported way out.
    const range = doc.bufferedPageRange();
    if (isDraft(d)) {
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        doc.save();
        doc.rotate(-35, { origin: [297, 421] });
        this.font(doc, "displaySemi", 110, DRAFT_RED).fillOpacity(0.08);
        doc.text("DRAFT", 0, 360, { width: 595, align: "center", lineBreak: false });
        doc.restore();
      }
    }
    const marks: Array<[string | null, number, number]> = [
      [asset("hookah-craft.png"), 17, (17 * 1113) / 1074],
      [asset("elixir-coterie.png"), 16, (16 * 1738) / 1469],
      [asset("cocktail-shop.png"), 24, 12],
    ];
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(0, 800).lineTo(doc.page.width, 800).lineWidth(0.8).strokeColor(RULE).stroke();
      let mx = left;
      for (const [file, w, h] of marks) {
        if (!file) continue;
        doc.image(file, mx, 815 - h / 2, { width: w, height: h });
        mx += w + 8;
      }
      this.font(doc, "text", 5.9, FAINT);
      doc.text(`${d.workspace.name} · ${d.workspace.website ?? ""} · GSTIN ${d.workspace.gstin ?? "—"}`, left, 808, { width, align: "center", lineBreak: false });
      doc.text(`Computer-generated ${d.docType === "ESTIMATE" ? "estimate" : "invoice"}. Contents are confidential and intended for the addressee.`, left, 819, { width, align: "center", lineBreak: false });
      this.font(doc, "text", 6.3, MUTED).text(d.invoiceNo, left, 808, { width, align: "right", characterSpacing: 1.1, lineBreak: false });
      this.font(doc, "text", 5.9, MUTED).text(`PAGE ${i + 1} OF ${range.count}`, left, 819, { width, align: "right", characterSpacing: 1.1, lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }
  }
}
