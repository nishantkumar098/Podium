import "reflect-metadata";
import { amountInWords } from "../src/invoices/amount-in-words";
import {
  computeTotals,
  financialYearFor,
  lineTaxable,
  outstanding,
  placeOfSupplyFor,
  recipientStateCode,
  settlementStatus,
  taxByRate,
} from "../src/invoices/invoice-math";
import { InvoicePdfService, type InvoicePdfData } from "../src/invoices/invoice-pdf.service";

// Pure arithmetic and rendering — no database. Named .e2e-spec only because
// that is the suite's testRegex.

// The 12 lines of the supplied "AMM Brands Tax invoice.pdf".
const SUPPLIED = [
  { qty: 1, rate: 185000, discountPct: 0 },
  { qty: 2, rate: 42500, discountPct: 0 },
  { qty: 8, rate: 4500, discountPct: 5 },
  { qty: 1, rate: 38000, discountPct: 0 },
  { qty: 1, rate: 26000, discountPct: 0 },
  { qty: 1, rate: 18500, discountPct: 0 },
  { qty: 12, rate: 1650, discountPct: 0 },
  { qty: 1, rate: 64000, discountPct: 7.5 },
  { qty: 1, rate: 12400, discountPct: 0 },
  { qty: 1, rate: 14800, discountPct: 0 },
  { qty: 1, rate: 22000, discountPct: 0 },
  { qty: 96, rate: 125, discountPct: 0 },
];

describe("invoice arithmetic", () => {
  it("reproduces the supplied tax invoice to the rupee", () => {
    const t = computeTotals(SUPPLIED, "07", "07");
    expect(t).toEqual({ taxableAmount: 526900, cgst: 47421, sgst: 47421, igst: 0, roundOff: 0, total: 621742 });
    expect(amountInWords(t.total)).toBe("Rupees Six Lakh Twenty One Thousand Seven Hundred Forty Two Only");
  });

  it("charges IGST, not CGST+SGST, across states", () => {
    const t = computeTotals(SUPPLIED, "07", "27");
    expect(t.igst).toBe(94842);
    expect(t.cgst + t.sgst).toBe(0);
    expect(t.total).toBe(621742);
  });

  it("applies line discounts", () => {
    expect(lineTaxable(8, 4500, 5)).toBe(34200);
    expect(lineTaxable(1, 64000, 7.5)).toBe(59200);
  });

  it("taxes each line at its own GST rate and bands the summary per rate", () => {
    // A Cocktail Shop order: two 18% items and one 5% item, within Delhi.
    const lines = [
      { qty: 2, rate: 700, discountPct: 0, gstRate: 0.18 },
      { qty: 1, rate: 500, discountPct: 0, gstRate: 0.18 },
      { qty: 4, rate: 250, discountPct: 0, gstRate: 0.05 },
    ];
    const bands = taxByRate(lines, "07", "07");
    expect(bands).toEqual([
      { rate: 0.18, taxable: 1900, cgst: 171, sgst: 171, igst: 0 },
      { rate: 0.05, taxable: 1000, cgst: 25, sgst: 25, igst: 0 },
    ]);
    expect(computeTotals(lines, "07", "07")).toEqual({ taxableAmount: 2900, cgst: 196, sgst: 196, igst: 0, roundOff: 0, total: 3292 });
    // Across states the same bands become IGST.
    expect(computeTotals(lines, "07", "27")).toMatchObject({ igst: 392, cgst: 0, sgst: 0, total: 3292 });
  });

  it("treats a line with no rate as 18%, so older invoices are unchanged", () => {
    expect(computeTotals(SUPPLIED.map((l) => ({ ...l, gstRate: 0.18 })), "07", "07")).toEqual(computeTotals(SUPPLIED, "07", "07"));
  });

  it("keeps paise noise out of the stored taxable value", () => {
    expect(computeTotals([{ qty: 3, rate: 0.1, discountPct: 0 }], "08", "08").taxableAmount).toBe(0.3);
  });
});

describe("place of supply", () => {
  it("uses the client's recorded state", () => {
    expect(placeOfSupplyFor({ gstStateCode: "27", gstin: null }, "08")).toBe("27");
  });

  it("derives the state from a GSTIN when no state code is keyed", () => {
    expect(recipientStateCode({ gstStateCode: null, gstin: "27AABCM1234F1Z5" })).toBe("27");
    expect(placeOfSupplyFor({ gstStateCode: null, gstin: "27AABCM1234F1Z5" }, "08")).toBe("27");
  });

  // Regression: issue() threw for every client without a state code — all
  // 52,241 imported clients — so no invoice could be issued at all.
  it("falls back to the supplier's state for an unregistered client with no state on record", () => {
    expect(placeOfSupplyFor({ gstStateCode: null, gstin: null }, "08")).toBe("08");
  });
});

describe("financial year", () => {
  // Regression: the FY was read in UTC, so an invoice issued between 00:00 and
  // 05:30 IST on 1 April was numbered into the previous year's series.
  it("reads the year in business time", () => {
    expect(financialYearFor(new Date("2026-03-31T20:00:00Z"))).toBe("26-27"); // 01:30 IST, 1 Apr
    expect(financialYearFor(new Date("2026-03-31T18:00:00Z"))).toBe("25-26"); // 23:30 IST, 31 Mar
  });
});

describe("settlement", () => {
  it("counts credit and debit notes in the balance", () => {
    expect(outstanding(100000, 60000, 10000, 2000)).toBe(32000);
  });

  // Regression: status compared payments to `total` only, so an invoice with
  // any credit note could never reach PAID.
  it("marks an invoice PAID once payments cover the credited amount", () => {
    expect(settlementStatus("PARTIALLY_PAID", 100000, 90000, 10000, 0)).toBe("PAID");
  });

  it("settles on a credit note that clears the balance", () => {
    expect(settlementStatus("PARTIALLY_PAID", 100000, 95000, 5000, 0)).toBe("PAID");
  });

  it("re-opens a PAID invoice when a debit note adds to it", () => {
    expect(settlementStatus("PAID", 100000, 100000, 0, 3000)).toBe("PARTIALLY_PAID");
  });

  // Regression: a part-payment on an OVERDUE invoice flipped it to
  // PARTIALLY_PAID, the next sweep flipped it back and re-notified the PM.
  it("keeps a part-paid overdue invoice OVERDUE", () => {
    expect(settlementStatus("OVERDUE", 100000, 20000, 0, 0)).toBe("OVERDUE");
  });

  it("moves an issued invoice to PARTIALLY_PAID on a part payment", () => {
    expect(settlementStatus("ISSUED", 100000, 20000, 0, 0)).toBe("PARTIALLY_PAID");
  });
});

describe("invoice PDF", () => {
  const data: InvoicePdfData = {
    invoiceNo: "AMM/DEL/26-27/0001",
    docType: "TAX_INVOICE",
    issueDate: new Date("2026-09-10T20:00:00Z"), // 01:30 IST on 11 Sep
    dueDate: new Date("2026-09-26T00:00:00Z"),
    status: "ISSUED",
    placeOfSupply: "27",
    placeOfSupplyName: "Maharashtra",
    paymentTerms: null,
    quotationRef: null,
    serviceLocation: null,
    ...computeTotals(SUPPLIED, "07", "27"),
    workspace: {
      name: "AMM BRANDS LLP", gstin: "07ACBFA2835N1ZB", address: "Green Park, New Delhi", website: "ammbrands.com",
      bankName: "Axis Bank", bankAccountName: "AMM BRANDS LLP", bankAccountNo: "1", bankIfsc: "UTIB0000015",
      invoiceTerms: ["Term one."], invoiceDeclaration: "Declaration.",
    },
    brand: null,
    city: { name: "Delhi", state: "Delhi", gstStateCode: "07" },
    client: { name: "Mumbai Hospitality", address: null, gstin: "27AABCM1234F1Z5", gstStateCode: "27", stateName: "Maharashtra" },
    project: { name: "Launch", eventDate: null },
    items: SUPPLIED.map((l, i) => ({ ...l, description: `Line ${i + 1}`, detail: null, unit: null, hsnSac: "9963", gstRate: 0.18, scope: i < 7 ? "FIXED" : "VARIABLE" })),
    payments: [],
    creditNotes: [],
    debitNotes: [],
  };

  // Regression: the footer was drawn inside the bottom margin, which made
  // pdfkit add a page per footer line — 6 pages for a 2-page invoice.
  it("renders a 12-line invoice on exactly 2 pages", async () => {
    const buf = await new InvoicePdfService().render(data);
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBe(2);
  });
});
