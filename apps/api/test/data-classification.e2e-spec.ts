import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import {
  AUDITED_TIERS,
  HR_MASTER_FIELDS,
  TIER_PERMISSION,
  USER_FIELD_TIERS,
  isGeneralUserField,
  userFieldTier,
} from "../src/common/data-classification";
import { SAFE_USER_SELECT } from "../src/common/safe-user";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * PHASE 0 §B/§C — field-level authorization, tested against the live API.
 *
 * The spreadsheet guard is an INGESTION safeguard. It stops salary, bank and
 * Aadhaar columns being read out of a workbook, and it says nothing at all
 * about what happens to a field once it is inside Podium. BUG-004 is the proof:
 * `passwordHash` left the server through `include: { pm: true }` on the
 * projects endpoint — nowhere near an importer, nowhere near a people screen.
 *
 * So these tests do not check the guard. They walk what the API actually
 * returns and fail on any field that is not classified GENERAL, and they check
 * that the classification itself stays exhaustive as the schema grows.
 */
describe("Data classification is enforced at the field (Phase 0 §B/§C)", () => {
  let app: INestApplication;
  let founder: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
  });

  afterAll(async () => await app.close());

  const get = (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${founder}`);

  /** Every key appearing anywhere in a response body, at any depth. */
  function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const v of value) keysDeep(v, into);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        into.add(k);
        keysDeep(v, into);
      }
    }
    return into;
  }

  describe("the classification itself", () => {
    it("covers every column on the User model — a new column cannot default to visible", () => {
      // Read from the schema rather than from the generated client: this must
      // fail when somebody ADDS a column, which is exactly when nobody is
      // thinking about classification.
      const schema = readFileSync(resolve(__dirname, "../../../packages/db/prisma/schema.prisma"), "utf8");
      const model = /model User \{([\s\S]*?)\n\}/.exec(schema)![1]!;

      const scalarFields = model
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
        .map((line) => line.split(/\s+/))
        .filter(([, type]) => type && /^(String|Int|Boolean|DateTime|Decimal|Json|Float|BigInt|Bytes)\??$/.test(type))
        .map(([name]) => name!);

      const unclassified = scalarFields.filter((f) => !(f in USER_FIELD_TIERS));
      expect([`unclassified User fields: ${unclassified.join(", ") || "none"}`, unclassified]).toEqual([
        "unclassified User fields: none",
        [],
      ]);
      expect(scalarFields.length).toBeGreaterThan(10); // the parse actually found fields
    });

    it("treats an unknown field as the most restricted thing it could be, never the least", () => {
      expect(userFieldTier("some_column_added_next_year")).toBe("HIGHLY_RESTRICTED");
      expect(isGeneralUserField("some_column_added_next_year")).toBe(false);
    });

    it("classifies every authentication field as CREDENTIAL, which no permission can unlock", () => {
      for (const field of ["passwordHash", "googleSub", "failedLoginAttempts", "lockedUntil", "passwordChangedAt"]) {
        expect([field, userFieldTier(field)]).toEqual([field, "CREDENTIAL"]);
      }
      // Not "a permission nobody holds" — no permission at all. There is no
      // role for which reading a password hash is correct.
      expect(TIER_PERMISSION.CREDENTIAL).toBeNull();
    });

    it("the shared serializer contains only GENERAL fields", () => {
      const notGeneral = Object.keys(SAFE_USER_SELECT).filter((f) => !isGeneralUserField(f));
      expect(notGeneral).toEqual([]);
    });

    it("audits reads of compensation and identity data, and does not bother auditing general data", () => {
      expect(AUDITED_TIERS.has("RESTRICTED")).toBe(true);
      expect(AUDITED_TIERS.has("HIGHLY_RESTRICTED")).toBe(true);
      expect(AUDITED_TIERS.has("GENERAL")).toBe(false);
    });
  });

  describe("the permissions that gate the restricted tiers", () => {
    it("exist in the database", async () => {
      for (const action of ["view_restricted", "view_identity"]) {
        const permission = await prisma.permission.findFirst({ where: { resource: "people", action } });
        expect([action, permission !== null]).toEqual([action, true]);
      }
    });

    it("are held by NOBODY — including the founder", async () => {
      const holders = await prisma.rolePermission.findMany({
        where: { permission: { resource: "people", action: { in: ["view_restricted", "view_identity"] } } },
        include: { role: true, permission: true },
      });
      // If this fails, somebody granted access to compensation or identity
      // data. That may be correct — but it must be a decision, and this is
      // where it becomes visible.
      expect(holders.map((h) => `${h.role.name}:${h.permission.action}`)).toEqual([]);
    });
  });

  describe("what the live API actually returns", () => {
    const endpoints = [
      "/api/users",
      "/api/projects",
      "/api/leads?limit=5",
      "/api/clients?limit=5",
      "/api/tasks",
      "/api/flow-instances",
    ];

    it.each(endpoints)("%s returns no field outside the GENERAL tier", async (endpoint) => {
      const res = await get(endpoint);
      expect([endpoint, res.status]).toEqual([endpoint, 200]);

      // Only the fields this classification knows about are judged: a
      // Project's `revenue` is not a User field and is not in scope here.
      const classified = Object.keys(USER_FIELD_TIERS);
      const returned = [...keysDeep(res.body)];
      const leaked = returned.filter((k) => classified.includes(k) && !isGeneralUserField(k));

      expect([endpoint, leaked]).toEqual([endpoint, []]);
    });

    it("/api/users/me exposes nothing beyond identity and session state", async () => {
      const res = await get("/api/users/me");
      expect(res.status).toBe(200);
      // mustChangePassword is CREDENTIAL-tier as a stored column, and is
      // returned here deliberately: it is the caller's own session state,
      // about themselves, and the change-password screen cannot work without
      // it. Recorded as the one intentional exception rather than left as an
      // inconsistency somebody has to rediscover.
      const leaked = [...keysDeep(res.body)].filter(
        (k) => k in USER_FIELD_TIERS && !isGeneralUserField(k) && k !== "mustChangePassword",
      );
      expect(leaked).toEqual([]);
    });
  });

  describe("AMM's HR master, classified before import rather than after", () => {
    it("every column of the employee sheet is accounted for", () => {
      // The 16 columns as the workbook writes them, spelling included.
      const workbookColumns = [
        "NAME", "SALARY DETAILS", "GENDER", "DOB", "DOJ", "SALARY DETAILS", "Bank Details", "Adhar Card",
        "Email Address", "DESIGNATION", "DEPARTMENT", "KRA", "Phone Number", "OFFICIAL NUMBER",
        "OFFICIAL EMAIL-ID", "OFFICE LOCATION",
      ];
      const classified = new Set(HR_MASTER_FIELDS.map((f) => f.column));
      const missing = [...new Set(workbookColumns)].filter((c) => !classified.has(c));
      expect(missing).toEqual([]);
    });

    it("nothing in a restricted tier is recorded as being stored anywhere", () => {
      const restricted = HR_MASTER_FIELDS.filter((f) => f.tier !== "GENERAL");
      expect(restricted.length).toBeGreaterThan(0);
      for (const field of restricted) {
        expect([field.column, field.store.startsWith("NOT IMPORTED")]).toEqual([field.column, true]);
      }
    });

    it("an Aadhaar document LINK is classified as harshly as an Aadhaar number", () => {
      const aadhaar = HR_MASTER_FIELDS.find((f) => f.column === "Adhar Card")!;
      expect(aadhaar.tier).toBe("HIGHLY_RESTRICTED");
      // A URL to a scan is not a weaker form of the identifier: anyone holding
      // the link can open the document.
      expect(aadhaar.store).toMatch(/link/i);
    });

    it("and no User column exists that could hold any of it", async () => {
      const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`;
      const names = columns.map((c) => c.column_name.toLowerCase());
      // The strongest field-level control is not holding the field. This
      // asserts that decision against the real database, so "we decided not to
      // store it" cannot quietly stop being true.
      for (const forbidden of ["salary", "ctc", "bank", "account_no", "ifsc", "aadhaar", "aadhar", "adhar", "pan", "uan", "passport"]) {
        const found = names.filter((n) => n.includes(forbidden));
        expect([forbidden, found]).toEqual([forbidden, []]);
      }
    });
  });
});
