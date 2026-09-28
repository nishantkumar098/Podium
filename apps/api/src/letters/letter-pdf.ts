import { join } from "path";
import PDFDocument from "pdfkit";
import type { Block, Run } from "./letter-content";

/**
 * Draws a letter on AMM's letterhead as a PDF. Same engine as the invoice
 * PDFs (pdfkit, built-in Helvetica): no Word, LibreOffice or browser is
 * needed on the server, and output is identical wherever it runs.
 */
const LOGO = join(__dirname, "assets", "amm-logo.png");
/** Archit Singhal's signature, taken from AMM's own signed letter. */
const SIGNATURE = join(__dirname, "assets", "archit-signature.png");
const SIGNATURE_H = 34;
const LOGO_W = 118;
const LOGO_H = (LOGO_W * 338) / 728; // the logo's own aspect ratio

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const LEFT = 62;
const RIGHT = PAGE_W - 62;
const WIDTH = RIGHT - LEFT;
const CONTENT_TOP = 138;
const BOTTOM = 70;
const MAX_Y = PAGE_H - BOTTOM;

const SIZE = 10.5;
const LINE_GAP = 2.2;
const PARA_GAP = 6;
const INK = "#111111";
const MUTED = "#555555";
const RULE = "#222222";

const FONT = "Helvetica";
const BOLD = "Helvetica-Bold";

/**
 * Helvetica's built-in encoding (WinAnsi) has no glyph for the rupee sign or
 * most non-Latin scripts; pdfkit would print them as junk. Anything outside
 * it is swapped for its nearest safe form rather than silently garbled.
 */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfSafe(text: string): string {
  return text
    .replace(/₹\s?/g, "INR ")
    .replace(/[−]/g, "-")
    .replace(/\t/g, " ")
    .replace(/[^\n -~ -ÿ]/g, (c) => (WIN_ANSI_EXTRA.includes(c) ? c : "?"));
}

const runText = (r: Run) => pdfSafe(typeof r === "string" ? r : r.b);
const isBold = (r: Run) => typeof r !== "string";

export function renderLetterPdf(title: string, blocks: Block[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: CONTENT_TOP, bottom: BOTTOM, left: LEFT, right: PAGE_W - RIGHT },
      bufferPages: true,
      info: { Title: pdfSafe(title), Author: "AMM Brands LLP", Creator: "Podium" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      letterhead(doc);
      // Pages added automatically when text overflows get the letterhead too.
      // This can fire in the middle of a bold phrase, so the font in use is
      // put back afterwards — otherwise the sentence resumes in regular type.
      doc.on("pageAdded", () => {
        const d = doc as unknown as { _font: unknown; _fontSize: number };
        const font = d._font;
        const size = d._fontSize;
        letterhead(doc);
        d._font = font;
        doc.fontSize(size);
      });
      for (const block of blocks) draw(doc, block);
      footers(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function letterhead(doc: PDFKit.PDFDocument): void {
  doc.image(LOGO, (PAGE_W - LOGO_W) / 2, 22, { width: LOGO_W });
  const lineY = 22 + LOGO_H + 8;
  doc.moveTo(LEFT - 20, lineY).lineTo(RIGHT + 20, lineY).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.font(FONT).fontSize(8).fillColor(MUTED);
  doc.text("Address: H-12 B Green Park Main, New Delhi 110016", LEFT, lineY + 6, { width: WIDTH, align: "center", lineBreak: false });
  doc.text("contact@ammbrands.com     |     www.ammbrands.com     |     011 4611 0364", LEFT, lineY + 17, {
    width: WIDTH,
    align: "center",
    lineBreak: false,
  });
  doc.moveTo(LEFT - 20, lineY + 30).lineTo(RIGHT + 20, lineY + 30).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.fillColor(INK).font(FONT).fontSize(SIZE);
  doc.x = LEFT;
  doc.y = CONTENT_TOP;
}

function footers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits in the bottom margin; with the margin in force pdfkit
    // would start a new page for it (the bug that made invoices 6 pages long).
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LEFT, PAGE_H - 46).lineTo(RIGHT, PAGE_H - 46).lineWidth(0.4).strokeColor("#999999").stroke();
    doc.font(FONT).fontSize(7.5).fillColor(MUTED);
    doc.text("AMM BRANDS LLP  ·  ammbrands.com", LEFT, PAGE_H - 38, { width: WIDTH, align: "left", lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, LEFT, PAGE_H - 38, { width: WIDTH, align: "right", lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

// ------------------------------------------------------------ measuring
function runsHeight(doc: PDFKit.PDFDocument, runs: Run[], width: number): number {
  const text = runs.map(runText).join("");
  if (!text.trim()) return SIZE;
  // Measured in bold when any run is bold — bold is wider, so this errs on the tall side.
  doc.font(runs.some(isBold) ? BOLD : FONT).fontSize(SIZE);
  return doc.heightOfString(text, { width, lineGap: LINE_GAP });
}

function tableRowHeight(doc: PDFKit.PDFDocument, cells: string[], widths: number[], bold: boolean): number {
  doc.font(bold ? BOLD : FONT).fontSize(9.5);
  return Math.max(...cells.map((c, i) => doc.heightOfString(pdfSafe(c) || " ", { width: widths[i]! - 10 }))) + 10;
}

function blockHeight(doc: PDFKit.PDFDocument, block: Block): number {
  switch (block.t) {
    case "title":
      return 30;
    case "h":
      return 26;
    case "space":
      return block.h;
    case "signature":
      return SIGNATURE_H + 8;
    case "p":
      return runsHeight(doc, block.runs, WIDTH) + (block.gap ?? PARA_GAP);
    case "list":
      return block.items.reduce((h, item) => h + runsHeight(doc, item, WIDTH - 22) + 4, 0) + PARA_GAP;
    case "table": {
      const widths = block.widths.map((w) => w * WIDTH);
      return [block.header, ...block.rows].reduce((h, r, i) => h + tableRowHeight(doc, r, widths, i === 0), 0) + PARA_GAP;
    }
    case "keep":
      return block.blocks.reduce((h, b) => h + blockHeight(doc, b), 0);
  }
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > MAX_Y && needed < MAX_Y - CONTENT_TOP) doc.addPage();
}

// --------------------------------------------------------------- drawing
function drawRuns(doc: PDFKit.PDFDocument, runs: Run[], x: number, width: number, align: string): void {
  const parts = runs.map((r) => ({ text: runText(r), bold: isBold(r) })).filter((r) => r.text.length > 0);
  if (parts.length === 0) {
    doc.moveDown(0.5);
    return;
  }
  const y = doc.y;
  // pdfkit cannot justify across a bold/regular switch — it stretches the
  // joining line oddly — so mixed paragraphs are set flush-left instead.
  if (align === "justify" && new Set(parts.map((p) => p.bold)).size > 1) align = "left";
  parts.forEach((part, i) => {
    doc.font(part.bold ? BOLD : FONT).fontSize(SIZE).fillColor(INK);
    const opts = { width, align: align as "left", lineGap: LINE_GAP, continued: i < parts.length - 1 };
    if (i === 0) doc.text(part.text, x, y, opts);
    else doc.text(part.text, opts);
  });
}

function draw(doc: PDFKit.PDFDocument, block: Block): void {
  switch (block.t) {
    case "title": {
      ensureRoom(doc, 60);
      doc.font(BOLD).fontSize(14).fillColor(INK).text(pdfSafe(block.text), LEFT, doc.y, { width: WIDTH, align: "center", underline: true });
      doc.y += 12;
      return;
    }
    case "h": {
      ensureRoom(doc, 60); // never leave a heading alone at the bottom of a page
      doc.y += 6;
      doc.font(BOLD).fontSize(11).fillColor(INK).text(pdfSafe(block.text), LEFT, doc.y, { width: WIDTH });
      doc.y += 5;
      return;
    }
    case "space":
      doc.y = Math.min(doc.y + block.h, MAX_Y);
      return;
    case "signature": {
      // A missing image file must never stop a letter printing: leave the
      // space to sign by hand instead.
      try {
        doc.image(SIGNATURE, LEFT, doc.y + 2, { height: SIGNATURE_H });
      } catch {
        // no signature image — hand-sign space left below
      }
      doc.y += SIGNATURE_H + 8;
      doc.x = LEFT;
      return;
    }
    case "p": {
      // A short all-bold line ("Exclusions:", "Note:") labels what follows —
      // keep room for it plus a line or two so it is never stranded at a page foot.
      const isLabel = block.runs.length > 0 && block.runs.every(isBold) && runsHeight(doc, block.runs, WIDTH) <= SIZE * 1.6;
      ensureRoom(doc, isLabel ? 60 : Math.min(runsHeight(doc, block.runs, WIDTH), 3 * SIZE));
      drawRuns(doc, block.runs, LEFT, WIDTH, block.align ?? "left");
      doc.y += block.gap ?? PARA_GAP;
      return;
    }
    case "list": {
      const indent = 22;
      block.items.forEach((item, i) => {
        ensureRoom(doc, runsHeight(doc, item, WIDTH - indent));
        const y = doc.y;
        doc.font(FONT).fontSize(SIZE).fillColor(INK);
        doc.text(block.style === "number" ? `${i + 1}.` : "•", LEFT + 4, y, { width: indent - 4, lineBreak: false });
        doc.y = y;
        drawRuns(doc, item, LEFT + indent, WIDTH - indent, "justify");
        doc.y += 4;
      });
      doc.y += PARA_GAP - 4;
      return;
    }
    case "table": {
      const widths = block.widths.map((w) => w * WIDTH);
      const drawRow = (cells: string[], header: boolean) => {
        const h = tableRowHeight(doc, cells, widths, header);
        let x = LEFT;
        const y = doc.y;
        cells.forEach((c, i) => {
          if (header) doc.rect(x, y, widths[i]!, h).fillColor("#eeeeee").fill();
          doc.rect(x, y, widths[i]!, h).lineWidth(0.6).strokeColor("#444444").stroke();
          doc.font(header ? BOLD : FONT).fontSize(9.5).fillColor(INK).text(pdfSafe(c), x + 5, y + 5, { width: widths[i]! - 10 });
          x += widths[i]!;
        });
        doc.y = y + h;
      };
      ensureRoom(doc, tableRowHeight(doc, block.header, widths, true) * 2);
      drawRow(block.header, true);
      for (const row of block.rows) {
        if (doc.y + tableRowHeight(doc, row, widths, false) > MAX_Y) {
          doc.addPage();
          drawRow(block.header, true);
        }
        drawRow(row, false);
      }
      doc.x = LEFT;
      doc.y += PARA_GAP;
      return;
    }
    case "keep": {
      ensureRoom(doc, blockHeight(doc, block));
      for (const b of block.blocks) draw(doc, b);
      return;
    }
  }
}
