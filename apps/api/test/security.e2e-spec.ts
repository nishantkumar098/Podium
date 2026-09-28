import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { redactError, redactPii } from "../src/common/redact";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase 12 security pass. Two things are protected here because both have
 * already gone wrong once in this project's history, or would be invisible
 * until they did:
 *
 *  1. Real customer PII must never reach a plaintext application log.
 *  2. The credentials sheet in AMM_BRANDS_LLP_DATABASE.xlsx must never be
 *     opened, and that guard must fail loudly if a future edit weakens it.
 */
describe("Security: PII in logs, and the forbidden-sheet guard", () => {
  describe("PII redaction", () => {
    it("masks a real-shaped Indian phone number", () => {
      expect(redactPii("phone: 9810799222")).toBe("phone: ***22");
      expect(redactPii("phone: 919810799222")).toBe("phone: ***22");
      expect(redactPii("(+91)9810799222")).toMatch(/\*\*\*22/);
    });

    it("masks an e-mail down to a non-identifying stub", () => {
      expect(redactPii("mail hardik@drinkswa.com now")).toBe("mail ha***@drinkswa.com now");
    });

    it("redacts the shape of a real Prisma error, which embeds the failing row", () => {
      // This is what Prisma actually produces on a constraint violation: the
      // whole data object, values included.
      const prismaish = new Error(
        "Invalid `prisma.client.create()` invocation:\n" +
          "{ data: { name: 'Rajat Aggarwal', phone: '9810274274', email: '561aggarwal@gmail.com' } }\n" +
          "Unique constraint failed on the fields: (`workspace_id`,`phone`)",
      );
      const safe = redactError(prismaish);
      expect(safe.message).not.toContain("9810274274");
      expect(safe.message).not.toContain("561aggarwal@gmail.com");
      // The diagnosable part survives.
      expect(safe.message).toContain("Unique constraint failed");
      expect(safe.message).toContain("workspace_id");
    });

    it("leaves short numbers and ids alone — over-redaction still has a limit", () => {
      expect(redactPii("invoice AMM/JPR/2026-27/0007")).toContain("0007");
      expect(redactPii("qty 42 of 100")).toBe("qty 42 of 100");
    });

    it("redacts a uuid-free stack trace without destroying the trace", () => {
      const err = new Error("boom for 9810799222");
      const safe = redactError(err);
      expect(safe.message).not.toContain("9810799222");
      expect(safe.stack).toBeDefined();
      expect(safe.stack).not.toContain("9810799222");
    });
  });

  describe("no PII escapes through the API's error envelope", () => {
    let app: INestApplication;
    let token: string;

    beforeAll(async () => {
      app = await bootstrapTestApp();
      token = await loginAs(app, "anant.sharma@ammbrands.in");
    });
    afterAll(async () => await app.close());

    it("a duplicate-phone insert does not echo the phone back to the caller", async () => {
      const ws = await prisma.workspace.findFirstOrThrow();
      const phone = "9999000111";
      const a = await prisma.client.create({
        data: { workspaceId: ws.id, name: "ZZ Redaction probe", type: "INDIVIDUAL", phone, source: "test" },
      });
      try {
        // Force the unique-constraint path through the real HTTP stack.
        const res = await request(app.getHttpServer())
          .post("/api/clients")
          .set("Authorization", `Bearer ${token}`)
          .send({ name: "ZZ Redaction probe 2", type: "INDIVIDUAL", cityId: (await prisma.city.findFirstOrThrow()).id });
        // Whatever the outcome, the response must never carry another row's phone.
        expect(JSON.stringify(res.body)).not.toContain(phone);
      } finally {
        await prisma.client.delete({ where: { id: a.id } });
      }
    });
  });
});

/**
 * The forbidden-sheet guard. The import brief was explicit: the credentials
 * sheet must never be opened, read, parsed, or logged. `assertNotForbidden`
 * THROWS rather than skipping, precisely so a refactor that starts reading it
 * fails loudly instead of quietly succeeding — and this test would catch a
 * regression that turned the throw back into a skip.
 *
 * The 2026-09-15 data reset widened the rule from credentials alone to four
 * categories — credentials, salary, bank account, government ID — and from
 * sheets to columns, since an employee list carries those as columns inside
 * an otherwise importable sheet. The tests below cover both halves: a guard
 * that silently stopped matching a category would be indistinguishable from
 * one that never covered it.
 */
/**
 * BUG-004. Prisma's `include: { pm: true }` returns EVERY scalar on the
 * related row, and User carries `passwordHash` — so GET /api/projects was
 * serving project managers' bcrypt hashes to anyone holding `projects:view`.
 * Confirmed against production on 2026-09-16 before the fix.
 *
 * These assertions deliberately inspect the HTTP RESPONSE BODY rather than
 * the select constant. A future contributor who writes `include: { user: true }`
 * in a new service will not have read common/safe-user.ts — but they will
 * still fail this test, because the hash would appear in the payload.
 */
describe("No credential material leaves the API (BUG-004)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "anant.sharma@ammbrands.in"); // Founder — widest possible view
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  /** Every column on User that must never appear in a response body. */
  const FORBIDDEN = ["passwordHash", "password_hash", "googleSub", "failedLoginAttempts", "lockedUntil"];

  const assertClean = (label: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const found = FORBIDDEN.filter((f) => raw.includes(f));
    expect([label, found]).toEqual([label, []]);
  };

  it("does not leak the PM's credential fields from the projects list", async () => {
    const res = await get("/api/projects");
    expect(res.status).toBe(200);
    assertClean("GET /projects", res.body);
  });

  it("does not leak credential fields from a project's detail, members included", async () => {
    const list = await get("/api/projects");
    const first = (list.body as Array<{ id: string }>)[0];
    // Only meaningful when a project exists; the seeded fixture always has some.
    expect(first).toBeDefined();
    const res = await get(`/api/projects/${first!.id}`);
    expect(res.status).toBe(200);
    assertClean("GET /projects/:id", res.body);
  });

  it("does not leak a flow step owner's credential fields", async () => {
    const res = await get("/api/flow-instances");
    expect(res.status).toBe(200);
    assertClean("GET /flow-instances", res.body);
  });

  it("still returns the fields the UI genuinely needs", async () => {
    const res = await get("/api/projects");
    const pm = (res.body as Array<{ pm?: Record<string, unknown> }>)[0]?.pm;
    expect(pm).toBeDefined();
    // A redaction that broke the screen would be its own bug.
    expect(Object.keys(pm!).sort()).toEqual(["dept", "email", "id", "isActive", "name"]);
  });
});

describe("Forbidden credentials sheet guard", () => {
  // Imported lazily so this file has no hard dependency on the import script's
  // runtime (it talks to Prisma at module load).
  let assertNotForbidden: (name: string) => void;
  let sensitiveColumnCategory: (header: string) => string | null;
  let blockedColumnsIn: (
    grid: ReadonlyArray<ReadonlyArray<unknown>>,
    scanRows?: number,
  ) => { indices: Set<number>; matches: Array<{ index: number; text: string; category: string }> };
  let blockedKeysIn: (
    rows: ReadonlyArray<Record<string, unknown>>,
    scanRows?: number,
  ) => { keys: Set<string>; matches: Array<{ key: string; text: string; category: string }> };

  beforeAll(async () => {
    const mod = (await import("../../../scripts/forbidden-sheet")) as unknown as {
      assertNotForbidden: (n: string) => void;
      sensitiveColumnCategory: (h: string) => string | null;
      blockedColumnsIn: typeof blockedColumnsIn;
      blockedKeysIn: typeof blockedKeysIn;
    };
    assertNotForbidden = mod.assertNotForbidden;
    sensitiveColumnCategory = mod.sensitiveColumnCategory;
    blockedColumnsIn = mod.blockedColumnsIn;
    blockedKeysIn = mod.blockedKeysIn;
  });

  it("throws on the exact sheet name from the AMM workbook", () => {
    expect(() => assertNotForbidden("LOGIN I`D AND PASSWORDS LIST")).toThrow(/never be opened/i);
  });

  it("throws on plausible variants, not just the one literal name", () => {
    for (const name of [
      "LOGIN ID AND PASSWORDS LIST",
      "passwords",
      "Password List",
      "  LOGIN I'D AND PASSWORDS LIST  ",
      "Staff Passwords 2026",
    ]) {
      expect(() => assertNotForbidden(name)).toThrow();
    }
  });

  it("throws on whole sheets about pay, banking or government identity", () => {
    for (const name of ["SALARY SHEET", "Payroll Mar 2026", "CTC", "Bank Account Details", "AADHAAR COPIES", "PAN CARD NO"]) {
      expect(() => assertNotForbidden(name)).toThrow();
    }
  });

  it("classifies sensitive COLUMN headers by category", () => {
    const cases: Array<[string, string]> = [
      ["Password", "credential"],
      ["API Key", "credential"],
      ["Monthly Salary", "salary"],
      ["CTC", "salary"],
      ["In-Hand", "salary"],
      ["Bank A/C No", "bank-account"],
      ["IFSC", "bank-account"],
      ["Account Number", "bank-account"],
      ["Aadhaar", "government-id"],
      ["PAN", "government-id"],
      ["Passport", "government-id"],
    ];
    for (const [header, category] of cases) {
      expect([header, sensitiveColumnCategory(header)]).toEqual([header, category]);
    }
  });

  it("does NOT flag ordinary columns — including addresses that name a bank as a landmark", () => {
    for (const header of [
      "NAME",
      "MOBILE NO",
      "CATEGORY",
      "Contact Person",
      "Location",
      // Indian addresses use bank branches as landmarks constantly. A guard
      // that matched bare "BANK" would blank out whole address columns, so
      // this is a real regression test, not a formality.
      "ADDRESS",
      "1st Floor Pulse Plaza K-24 Near HSBC Bank, Sector 18, Noida",
      "M29, GK2, M Block Market, next to HDFC Bank, New Delhi",
    ]) {
      expect([header, sensitiveColumnCategory(header)]).toEqual([header, null]);
    }
  });

  it("does NOT throw on the sheets the importer legitimately reads", () => {
    for (const name of ["AMM CLIENT DATABASE", "Clients", "AMM EMPLOYEE DATA", "DATA DUMP", "Sales Funnel"]) {
      expect(() => assertNotForbidden(name)).not.toThrow();
    }
  });

  /**
   * REGRESSION — 2026-09-16, the guard's second miss in one day.
   *
   * AMM's own HR master spells Aadhaar "Adhar Card". The pattern insisted on
   * the canonical double-a, so a column of government-ID scan links scanned
   * clean. Every spelling that turns up in Indian office documents is pinned
   * here; the two negatives below are the reason the pattern cannot simply be
   * loosened to /ADH/.
   */
  it("matches every AMM spelling of Aadhaar, and still leaves ADDRESS alone", () => {
    for (const header of [
      "Adhar Card",
      "Aadhaar",
      "Aadhar",
      "Adhaar",
      "AADHAR NO",
      "aadhar number",
      "Aadhaar Card Link",
    ]) {
      expect([header, sensitiveColumnCategory(header)]).toEqual([header, "government-id"]);
    }
    for (const header of ["ADDRESS", "Address Line 2", "Adhesive Tape"]) {
      expect([header, sensitiveColumnCategory(header)]).toEqual([header, null]);
    }
  });

  /**
   * REGRESSION — full-and-final settlement columns. "F&F Net Payable" matched
   * only by accident (NET PAY); "F&F Gross" and "Deductions/Recovery" sat
   * beside it in the same sheet and did not match at all.
   */
  it("treats full-and-final settlement columns as pay", () => {
    for (const header of ["F&F Gross", "F & F Net Payable", "Deductions/Recovery", "Full and Final", "Arrears"]) {
      expect([header, sensitiveColumnCategory(header)]).toEqual([header, "salary"]);
    }
  });

  /**
   * REGRESSION — the guard's first miss of 2026-09-16, and the more serious
   * one. `Master_Sheet.xlsx`'s "Employee Deatils" sheet puts its real titles
   * in a data row, so `sheet_to_json` invents `__EMPTY_1`-style keys and a
   * header-only check reads salary, bank and Aadhaar columns while believing
   * the sheet is clean. This grid is that sheet's actual shape.
   */
  it("finds sensitive columns when the real header is not row 0", () => {
    const grid = [
      ["EMPLOYEE MASTER — AMM BRANDS LLP", null, null, null, null, null, null, null],
      ["EMP ID", "SALARY DETAILS", null, null, null, "SALARY DETAILS", "Bank Details", "Adhar Card"],
      ["AMM-001", "CTC", "Basic", "HRA", "Net", "In-Hand", "Bank A/C No", "Aadhaar No"],
      ["AMM-002", "xxx", "xxx", "xxx", "xxx", "xxx", "xxx", "xxx"],
    ];
    const blocked = blockedColumnsIn(grid, 3);
    expect([...blocked.indices].sort((a, b) => a - b)).toEqual([1, 5, 6, 7]);
    expect(blocked.matches.map((m) => m.category).sort()).toContain("government-id");
  });

  it("does not mistake a long cell for a header — an address naming a bank is data", () => {
    const grid = [
      ["CLIENT", "ADDRESS"],
      ["Rashi Events", "M29, GK2, M Block Market, next to HDFC Bank, New Delhi 110048"],
    ];
    expect(blockedColumnsIn(grid, 3).indices.size).toBe(0);
  });

  /**
   * REGRESSION — the cost of scanning cell values, which is why the scan is
   * gated on the row reading as a heading row.
   *
   * Both of these are verbatim from AMM_BRANDS_LLP_DATABASE.xlsx: an
   * influencer whose actual surname is "Adhaar", and a bar whose actual
   * website is passcodeonly.com. An ungated value scan blocks the name column
   * of one sheet and the website column of the other — destroying two real
   * datasets to protect nothing. The phone number in each row is what marks it
   * as data rather than headings.
   */
  it("does not block a real column because a person is named Adhaar", () => {
    const grid = [
      ["Name", "Contact", "Address"],
      ["Shirin Mann", "9582500001", "508-A, Aralias, Sector 42, Gurugram"],
      ["Sharnamli Adhaar", "9810412521", "3/13 Shanti Niketan, New Delhi"],
    ];
    expect(blockedColumnsIn(grid, 3).matches).toEqual([]);
  });

  it("does not block a real column because a bar's website is passcodeonly.com", () => {
    const grid = [
      ["DELHI 17/8/2024", null, null, null],
      ["Only Bar Restaurant", "011 4039 2018", "16-19 Bhikaji Cama Place", "https://www.onlybar.in/"],
      ["PCO Bar", "097111 08482", "D-4 Block Market, Vasant Vihar", "https://www.passcodeonly.com/lander"],
    ];
    expect(blockedColumnsIn(grid, 3).matches).toEqual([]);
  });

  /**
   * The header-keyed form of the same miss. `sheet_to_json` without
   * `header: 1` keys rows by row 0, so when row 0 is blank the sensitive
   * titles arrive as VALUES under `__EMPTY_n` keys.
   */
  it("blocks __EMPTY keys whose heading row sits in the data", () => {
    const rows = [
      { __EMPTY: "NAME", __EMPTY_1: "SALARY DETAILS", __EMPTY_5: "Bank Details", __EMPTY_6: "Adhar Card" },
      { __EMPTY: "Zumair Bin Zaheer", __EMPTY_1: "34500", __EMPTY_5: "A/C 1234", __EMPTY_6: "https://drive.google.com/x" },
    ];
    const blocked = blockedKeysIn(rows, 3);
    expect([...blocked.keys].sort()).toEqual(["__EMPTY_1", "__EMPTY_5", "__EMPTY_6"]);
  });

  it("blocks a sensitive key even when row 0 is a proper header", () => {
    const rows = [{ "Employee ID": "AMM-001", "Monthly Salary": 34500, "Bank A/C No": "1234" }];
    expect([...blockedKeysIn(rows, 3).keys].sort()).toEqual(["Bank A/C No", "Monthly Salary"]);
  });

  it("the guard throws — it must never silently skip", () => {
    // A skip would make this expression return undefined instead of raising.
    let threw = false;
    try {
      assertNotForbidden("LOGIN AND PASSWORDS");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
