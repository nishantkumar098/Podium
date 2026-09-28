import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { amountInWords } from "../src/invoices/amount-in-words";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * The two invoice formats AMM actually issues (design supplied 2026-09-15):
 * a TAX_INVOICE and an ESTIMATE, off the same data, with line items split
 * into FIXED SCOPE and VARIABLE SCOPE sections.
 *
 * Every assertion here is scoped to a row this test uniquely owns. The test
 * database is shared and grows on every run, so asserting on "the first
 * invoice" or on a global count passes once and then rots — the failure mode
 * that has bitten this suite in four previous phases.
 */
describe("Invoice formats — fixed/variable scope, tax invoice vs estimate (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance Manager
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body?: unknown) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});
  const get = (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  /** An intra-state project so the document exercises the CGST/SGST path. */
  async function jaipurProject() {
    const city = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const project = await prisma.project.findFirstOrThrow({ where: { cityId: city.id } });
    return { city, project };
  }

  // Mirrors the shape of the supplied invoice: contracted lines, then lines
  // billed on actuals, with a discount on one of each.
  const ITEMS = [
    { description: "Event management & production", detail: "Concept, planning, execution", qty: 1, unit: "job", rate: 100000, hsnSac: "9963", scope: "FIXED" as const },
    { description: "Bartenders", detail: "8 bartenders, 10-hour shift", qty: 8, unit: "person", rate: 5000, discountPct: 10, hsnSac: "9963", scope: "FIXED" as const },
    { description: "Ice & consumables", detail: "Billed on consumption", qty: 1, unit: "lot", rate: 20000, scope: "VARIABLE" as const },
  ];
  // 100000 + (40000 - 10%) + 20000 = 100000 + 36000 + 20000
  const EXPECTED_TAXABLE = 156000;

  it("stores scope, unit, detail and discount on each line, in the submitted order", async () => {
    const { city, project } = await jaipurProject();
    const draft = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      docType: "TAX_INVOICE",
      paymentTerms: "50% advance, balance on event date",
      quotationRef: "43 dated 17 May 2026",
      serviceLocation: "Event venue, Jaipur",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: ITEMS,
    });
    expect(draft.status).toBe(201);

    const mine = await get(`/api/invoices/${draft.body.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.docType).toBe("TAX_INVOICE");
    expect(mine.body.paymentTerms).toBe("50% advance, balance on event date");
    expect(mine.body.quotationRef).toBe("43 dated 17 May 2026");
    expect(mine.body.serviceLocation).toBe("Event venue, Jaipur");

    const items = mine.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);

    const bartenders = items.find((i) => i.description === "Bartenders")!;
    expect(bartenders.scope).toBe("FIXED");
    expect(bartenders.unit).toBe("person");
    expect(bartenders.detail).toBe("8 bartenders, 10-hour shift");
    expect(Number(bartenders.discountPct)).toBe(10);

    const ice = items.find((i) => i.description === "Ice & consumables")!;
    expect(ice.scope).toBe("VARIABLE");
    // Submitted third, so it must print third — a document whose lines
    // reshuffle between renders cannot be reconciled against.
    expect(Number(ice.sortOrder)).toBe(2);
  });

  it("subtracts the per-line discount from the taxable value, on draft and on issue alike", async () => {
    const { city, project } = await jaipurProject();
    const draft = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: ITEMS,
    });
    // The draft already reflects the discount — not only the issued figure.
    expect(Number(draft.body.taxableAmount)).toBe(EXPECTED_TAXABLE);

    const issued = await post(`/api/invoices/${draft.body.id}/issue`);
    expect(issued.status).toBe(201);
    expect(Number(issued.body.taxableAmount)).toBe(EXPECTED_TAXABLE);

    const tax = Math.round(EXPECTED_TAXABLE * 0.18);
    expect(Number(issued.body.cgst)).toBe(tax / 2);
    expect(Number(issued.body.sgst)).toBe(tax / 2);
    expect(Number(issued.body.igst)).toBe(0);

    // The printed grand total is whole rupees, with the rounding carried on
    // its own line so the summary column adds up exactly.
    const total = Number(issued.body.total);
    const roundOff = Number(issued.body.roundOff);
    expect(Number.isInteger(total)).toBe(true);
    expect(total - roundOff).toBeCloseTo(EXPECTED_TAXABLE + tax, 2);
  });

  it("renders a tax invoice as a real PDF carrying both scope headings", async () => {
    const { city, project } = await jaipurProject();
    const draft = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      docType: "TAX_INVOICE",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: ITEMS,
    });
    await post(`/api/invoices/${draft.body.id}/issue`);

    const res = await get(`/api/invoices/${draft.body.id}/pdf`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const pdf = res.body as Buffer;
    // A real PDF, not an error page rendered with the wrong content type.
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
  });

  it("titles an estimate differently and omits the tax-invoice-only markers", async () => {
    const { city, project } = await jaipurProject();
    const estimate = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      docType: "ESTIMATE",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: ITEMS,
    });
    expect(estimate.status).toBe(201);
    expect(estimate.body.docType).toBe("ESTIMATE");

    // Drafts no longer render; an estimate is issued onto its own EST- series first.
    const issuedEstimate = await post(`/api/invoices/${estimate.body.id}/issue`);
    expect(issuedEstimate.status).toBe(201);
    expect(issuedEstimate.body.invoiceNo).toMatch(/\/EST-\d{4}$/);

    const res = await get(`/api/invoices/${estimate.body.id}/pdf`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("defaults scope to FIXED so a caller that knows nothing about scopes still works", async () => {
    const { city, project } = await jaipurProject();
    const draft = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: [{ description: "Legacy shaped line", qty: 2, rate: 500 }],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.items[0].scope).toBe("FIXED");
    expect(Number(draft.body.items[0].discountPct)).toBe(0);
    expect(Number(draft.body.taxableAmount)).toBe(1000);
  });

  it("rejects a discount above 100%, which would make the line negative", async () => {
    const { city, project } = await jaipurProject();
    const bad = await post("/api/invoices", {
      clientId: project.clientId,
      projectId: project.id,
      cityId: city.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: [{ description: "Over-discounted", qty: 1, rate: 1000, discountPct: 120 }],
    });
    expect(bad.status).toBe(400);
  });
});

/**
 * Indian numbering is not thousands-based past a point, so the usual
 * three-digit-group algorithm produces the wrong words. The first case below
 * is the exact figure and wording printed on the invoice AMM supplied.
 */
describe("amountInWords — Indian numbering", () => {
  it("matches the wording on the supplied AMM invoice", () => {
    expect(amountInWords(621742)).toBe("Rupees Six Lakh Twenty One Thousand Seven Hundred Forty Two Only");
  });

  it("handles the irregular teens and the round tens", () => {
    expect(amountInWords(15)).toBe("Rupees Fifteen Only");
    expect(amountInWords(70)).toBe("Rupees Seventy Only");
    expect(amountInWords(115)).toBe("Rupees One Hundred Fifteen Only");
  });

  it("groups by lakh and crore, not by thousand", () => {
    expect(amountInWords(100000)).toBe("Rupees One Lakh Only");
    expect(amountInWords(1000000)).toBe("Rupees Ten Lakh Only");
    expect(amountInWords(10000000)).toBe("Rupees One Crore Only");
    expect(amountInWords(12345678)).toBe(
      "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only",
    );
  });

  it("includes paise only when there are any", () => {
    expect(amountInWords(100)).toBe("Rupees One Hundred Only");
    expect(amountInWords(100.5)).toBe("Rupees One Hundred and Fifty Paise Only");
    expect(amountInWords(0)).toBe("Rupees Zero Only");
  });

  it("rounds to paise rather than dropping one to floating point", () => {
    // 0.145 in binary floating point is just under 0.145.
    expect(amountInWords(1.145)).toBe("Rupees One and Fifteen Paise Only");
  });
});
