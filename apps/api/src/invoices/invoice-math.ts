/**
 * The invoice arithmetic, with no database and no framework in it, so every
 * rule here is unit-testable and every caller (draft, issue, payment, note,
 * PDF, e-mail) gets the same answer.
 */
import { businessDateParts } from "../common/business-time";

export const GST_RATE = 0.18;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One line's taxable value: quantity x rate, less its own discount. */
export function lineTaxable(qty: number, rate: number, discountPct: number): number {
  const gross = qty * rate;
  return gross - gross * (discountPct / 100);
}

/**
 * The recipient's GST state, as far as the records actually say.
 *
 * A registered recipient's state is the first two digits of their GSTIN, so a
 * client with a GSTIN but no separately-keyed state code still has a known
 * state — deriving it is reading a fact, not guessing one.
 */
export function recipientStateCode(client: { gstStateCode: string | null; gstin: string | null }): string | null {
  if (client.gstStateCode && /^\d{2}$/.test(client.gstStateCode)) return client.gstStateCode;
  const fromGstin = client.gstin?.trim().slice(0, 2);
  return fromGstin && /^\d{2}$/.test(fromGstin) ? fromGstin : null;
}

/**
 * Place of supply. When the recipient's state is on record it is that state.
 * When it is not — an unregistered individual with no address state, which is
 * every retail and calendar client AMM has imported — IGST Act s.12(2)(b)(ii)
 * makes the place of supply the location of the supplier, i.e. the billing
 * branch. Refusing to issue in that case (the previous behaviour) blocked
 * invoicing for all 52,241 real clients.
 */
export function placeOfSupplyFor(
  client: { gstStateCode: string | null; gstin: string | null },
  supplierStateCode: string,
): string {
  return recipientStateCode(client) ?? supplierStateCode;
}

export interface InvoiceTotals {
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
}

export interface TaxLine {
  qty: number;
  rate: number;
  discountPct: number;
  /** GST rate as a fraction; lines without one are billed at the standard 18%. */
  gstRate?: number;
}

export interface TaxBand {
  /** GST rate as a fraction (0.18). */
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Tax per GST rate. Each band's tax is rounded to whole rupees before it is
 * split into CGST and SGST — the supplied invoice's rule — and the bands are
 * what the printed Tax Summary lists, one row per rate.
 */
export function taxByRate(items: ReadonlyArray<TaxLine>, supplierStateCode: string, placeOfSupply: string): TaxBand[] {
  const intra = supplierStateCode === placeOfSupply;
  const groups = new Map<number, number>();
  for (const i of items) {
    const rate = i.gstRate ?? GST_RATE;
    groups.set(rate, (groups.get(rate) ?? 0) + lineTaxable(i.qty, i.rate, i.discountPct));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, raw]) => {
      const taxable = round2(raw);
      const tax = Math.round(taxable * rate);
      return { rate, taxable, cgst: intra ? tax / 2 : 0, sgst: intra ? tax / 2 : 0, igst: intra ? 0 : tax };
    });
}

/**
 * GST per line rate (18% unless a line says otherwise), CGST+SGST when
 * supplier and place of supply share a state, IGST otherwise. The grand
 * total is rounded to whole rupees with the adjustment kept as its own
 * printed line. An invoice whose lines are all 18% comes out exactly as it
 * did when 18% was the only rate.
 */
export function computeTotals(items: ReadonlyArray<TaxLine>, supplierStateCode: string, placeOfSupply: string): InvoiceTotals {
  const bands = taxByRate(items, supplierStateCode, placeOfSupply);
  const taxableAmount = round2(items.reduce((s, i) => s + lineTaxable(i.qty, i.rate, i.discountPct), 0));
  const cgst = round2(bands.reduce((s, b) => s + b.cgst, 0));
  const sgst = round2(bands.reduce((s, b) => s + b.sgst, 0));
  const igst = round2(bands.reduce((s, b) => s + b.igst, 0));
  const beforeRounding = taxableAmount + cgst + sgst + igst;
  const total = Math.round(beforeRounding);
  return { taxableAmount, cgst, sgst, igst, roundOff: round2(total - beforeRounding), total };
}

/** Indian financial year (Apr–Mar) of an instant, read in business time — not UTC. */
export function financialYearFor(at: Date): string {
  const { year, month } = businessDateParts(at);
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

/**
 * What the customer owes after every adjustment. An issued invoice row is
 * immutable, so credit and debit notes change the amount due without changing
 * `total` — anything that compares payments against `total` alone is wrong as
 * soon as a note exists.
 */
export function amountDue(total: number, credited: number, debited: number): number {
  return round2(total - credited + debited);
}

export function outstanding(total: number, paid: number, credited: number, debited: number): number {
  return round2(amountDue(total, credited, debited) - paid);
}

type SettleableStatus = "ISSUED" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";

/** The status an issued invoice should hold given its money position. */
export function settlementStatus(
  current: SettleableStatus,
  total: number,
  paid: number,
  credited: number,
  debited: number,
): SettleableStatus {
  if (outstanding(total, paid, credited, debited) <= 0) return "PAID";
  if (current === "PAID") return paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
  if (paid > 0 && current !== "OVERDUE") return "PARTIALLY_PAID";
  return current;
}
