/**
 * What Podium is allowed to know about a person, and who may see it.
 *
 * WHY THIS EXISTS. The spreadsheet guard in `scripts/forbidden-sheet.ts` stops
 * salary, bank and Aadhaar columns being READ at import. That is an ingestion
 * safeguard and nothing more: it says nothing about what happens to a field
 * once it is inside the system, and it would not have prevented BUG-004, where
 * `passwordHash` walked out through `include: { pm: true }` on an endpoint
 * nobody thought of as a people endpoint.
 *
 * Authorization has to live at the field, in the API, independent of how the
 * data got there. This module is that classification.
 *
 * ---------------------------------------------------------------------------
 * THE TIERS
 *
 * GENERAL              Who somebody is and how to reach them at work. Travels
 *                      through the ordinary employee serializer.
 *
 * RESTRICTED           Compensation. Podium has no schema for it, and should
 *                      not: it is not a payroll system. Listed so that the
 *                      classification of an AMM field is never ambiguous, and
 *                      so an attempt to add one fails the test below.
 *
 * HIGHLY_RESTRICTED    Bank details, government identifiers, and links to
 *                      identity documents. Same: no schema, deliberately.
 *
 * CREDENTIAL           Authentication material. Exists in the schema because
 *                      logging in requires it, and must never leave the server
 *                      under any permission whatsoever — there is no role that
 *                      may read a password hash.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISION, STATED PLAINLY
 *
 * The strongest field-level control available is not to hold the field. AMM's
 * HR master carries salary, bank details and Google Drive links to Aadhaar
 * scans for 31 real people. Podium produces events; it has no feature that
 * needs any of it. Storing it "securely" would be strictly worse than not
 * storing it: it creates a breach surface, a retention obligation and a
 * compliance question, in exchange for nothing.
 *
 * So RESTRICTED and HIGHLY_RESTRICTED fields are NOT imported and have no
 * columns. What is built here is the architecture that makes that hold, and
 * that governs them if AMM ever decides Podium must carry them:
 *
 *   1. Tiering, per field, in one place (this file).
 *   2. An allow-list serializer — `SAFE_USER_SELECT` — rather than a
 *      deny-list, so a column added to User later is invisible by default
 *      instead of exposed by default.
 *   3. Permissions that gate the higher tiers, held by nobody today.
 *   4. An e2e test that walks the live API's responses and fails on any field
 *      not classified GENERAL.
 *
 * Point 2 is the load-bearing one. A deny-list is how BUG-004 happened.
 */

/** Sensitivity tiers, ordered least to most restricted. */
export const DATA_TIERS = ["GENERAL", "RESTRICTED", "HIGHLY_RESTRICTED", "CREDENTIAL"] as const;
export type DataTier = (typeof DATA_TIERS)[number];

/**
 * Permission required to read each tier.
 *
 * `people:view` is held by Founder, Admin and Operations today. The other two
 * are held by NOBODY — they are deliberately unassigned, so that granting
 * access to compensation or identity data is an explicit act by a named person
 * rather than something a role quietly already covers.
 *
 * CREDENTIAL has no permission at all, on purpose. There is no legitimate
 * reader; it is not a matter of holding the right role.
 */
export const TIER_PERMISSION: Record<DataTier, string | null> = {
  GENERAL: "people:view",
  RESTRICTED: "people:view_restricted",
  HIGHLY_RESTRICTED: "people:view_identity",
  CREDENTIAL: null,
};

/** Tiers whose access must be written to the audit log on every single read. */
export const AUDITED_TIERS: ReadonlySet<DataTier> = new Set<DataTier>(["RESTRICTED", "HIGHLY_RESTRICTED"]);

/**
 * Every column on `User`, classified. Exhaustive by test: a field added to the
 * Prisma model and not added here fails `data-classification.e2e-spec.ts`,
 * which is what stops a future column silently defaulting to visible.
 */
export const USER_FIELD_TIERS: Record<string, DataTier> = {
  // --- who they are, and how to reach them at work -------------------------
  id: "GENERAL",
  name: "GENERAL",
  username: "GENERAL",
  email: "GENERAL",
  dept: "GENERAL",
  isActive: "GENERAL",
  isExternal: "GENERAL",
  workspaceId: "GENERAL",
  primaryRoleId: "GENERAL",
  primaryCityId: "GENERAL",
  externalClientId: "GENERAL",
  externalVendorId: "GENERAL",
  createdAt: "GENERAL",
  updatedAt: "GENERAL",
  createdById: "GENERAL",
  updatedById: "GENERAL",
  deletedAt: "GENERAL",

  // --- authentication material: no reader, ever ----------------------------
  passwordHash: "CREDENTIAL",
  googleSub: "CREDENTIAL",
  mustChangePassword: "CREDENTIAL",
  failedLoginAttempts: "CREDENTIAL",
  lockedUntil: "CREDENTIAL",
  passwordChangedAt: "CREDENTIAL",
};

/**
 * AMM's HR master (`Master_Sheet.xlsx`, sheet "Employee Deatils", 31 people),
 * classified column by column BEFORE any import — which is the order §B
 * requires, and the opposite of importing first and restricting afterwards.
 *
 * `column` is the heading exactly as the workbook writes it, spelling included.
 * `store` says whether Podium takes the field at all.
 */
export interface HrSourceField {
  readonly column: string;
  readonly tier: DataTier;
  /** Where it lands, or why it does not land anywhere. */
  readonly store: string;
}

export const HR_MASTER_FIELDS: ReadonlyArray<HrSourceField> = [
  { column: "NAME", tier: "GENERAL", store: "User.name" },
  { column: "GENDER", tier: "GENERAL", store: "not stored — Podium has no feature that reads it" },
  { column: "DOB", tier: "GENERAL", store: "not stored — see AMM-DECISION-HR-DOB; a birthday list is the only use anyone has named" },
  { column: "DOJ", tier: "GENERAL", store: "not stored yet — employment metadata, no column exists (Phase 1)" },
  { column: "Email Address", tier: "GENERAL", store: "personal address — NOT stored; User.email is the official one" },
  { column: "OFFICIAL EMAIL-ID", tier: "GENERAL", store: "User.email" },
  { column: "DESIGNATION", tier: "GENERAL", store: "not stored yet — no column (Phase 1)" },
  { column: "DEPARTMENT", tier: "GENERAL", store: "User.dept" },
  { column: "KRA", tier: "GENERAL", store: "already imported from the KRA sheet" },
  { column: "Phone Number", tier: "GENERAL", store: "personal number — NOT stored" },
  { column: "OFFICIAL NUMBER", tier: "GENERAL", store: "not stored yet — no column (Phase 1)" },
  { column: "OFFICE LOCATION", tier: "GENERAL", store: "User.primaryCityId, where it maps to an operating city" },

  // Everything below is refused at ingestion by scripts/forbidden-sheet.ts and
  // has nowhere to be stored even if it were not.
  { column: "SALARY DETAILS", tier: "RESTRICTED", store: "NOT IMPORTED — no column exists; Podium is not a payroll system" },
  { column: "Bank Details", tier: "HIGHLY_RESTRICTED", store: "NOT IMPORTED — no column exists" },
  {
    column: "Adhar Card",
    tier: "HIGHLY_RESTRICTED",
    store:
      "NOT IMPORTED — the cells hold Google Drive links to Aadhaar scans. A link is not less sensitive than the number: " +
      "anyone who can read it can open the document. Treated identically to the identifier itself.",
  },
];

/** The tier of a User field. Unknown fields are treated as the most restricted thing they could be. */
export function userFieldTier(field: string): DataTier {
  return USER_FIELD_TIERS[field] ?? "HIGHLY_RESTRICTED";
}

/** Is this field safe to include in an ordinary people-facing response? */
export function isGeneralUserField(field: string): boolean {
  return userFieldTier(field) === "GENERAL";
}
