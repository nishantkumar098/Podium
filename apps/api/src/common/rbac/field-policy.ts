import type { RequestUser } from "../types";

/**
 * Field-level visibility.
 *
 * Page-level permissions answer "may you open this screen". They cannot
 * answer the question the business actually asks, which is: Operations must
 * see that ABC Events is confirmed and owes us 500 chairs, and must NOT see
 * that we are paying them Rs 4,50,000 for it. Both facts live on the same
 * row, returned by the same endpoint.
 *
 * So money and banking are classified per field here, and stripped from the
 * response for anyone without the matching permission. This is the same idea
 * as `data-classification.ts` (which governs the People model) generalised to
 * the operational records, and it is applied in the service — never in the
 * frontend, which can only hide what it was already sent.
 *
 * An allow-list would be safer still, but these models are wide and mostly
 * innocuous; what matters is that every SENSITIVE field is named, and that a
 * test fails when a new money column appears unclassified.
 */

/** field name -> permission needed to see it. A field absent from the map is visible to anyone who can read the record. */
export type FieldPolicy = Readonly<Record<string, string>>;

/**
 * Event economics. A Project row carries what the client pays and what the
 * event costs; that is company finance sitting on an operational record, and
 * it follows the finance rules, not the project ones.
 */
export const PROJECT_FIELD_POLICY: FieldPolicy = {
  revenue: "budgets:view",
  estCost: "budgets:view",
  actCost: "budgets:view",
  margin: "budgets:view",
  marginPct: "budgets:view",
};

/**
 * Vendor money. Deliberately narrower than "every number on the vendor": a
 * purchase order's own total stays visible to whoever may run procurement,
 * because negotiating and raising it is their job. What is closed off is the
 * vendor's banking, the running balance and the payment schedule — the
 * things that describe how much we pay them and how.
 */
export const VENDOR_FIELD_POLICY: FieldPolicy = {
  bankName: "payments:view",
  bankAccountNo: "payments:view",
  bankIfsc: "payments:view",
  upiId: "payments:view",
  pan: "payments:view",
  openingBalance: "payments:view",
  lastPaymentAt: "payments:view",
  nextPaymentDueAt: "payments:view",
  openOrders: "payments:view",
};

/** Does this person hold the permission a field needs? */
function mayRead(user: Pick<RequestUser, "permissions">, field: string, policy: FieldPolicy): boolean {
  const required = policy[field];
  return !required || user.permissions.has(required);
}

/**
 * A copy of `row` with every field the caller may not read removed.
 *
 * Removed, not nulled: a null would be indistinguishable from "this vendor
 * has no bank details on file", and the frontend would render an empty row
 * where it should render nothing at all. `redactedFields` is returned
 * alongside so a screen can say "hidden" honestly.
 */
export function redact<T extends Record<string, unknown>>(
  user: Pick<RequestUser, "permissions">,
  policy: FieldPolicy,
  row: T,
): T & { redactedFields?: string[] } {
  const hidden = Object.keys(policy).filter((f) => f in row && !mayRead(user, f, policy));
  if (hidden.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!hidden.includes(k)) out[k] = v;
  out.redactedFields = hidden;
  return out as T & { redactedFields: string[] };
}

/** `redact` over a list. */
export function redactAll<T extends Record<string, unknown>>(
  user: Pick<RequestUser, "permissions">,
  policy: FieldPolicy,
  rows: T[],
): Array<T & { redactedFields?: string[] }> {
  return rows.map((r) => redact(user, policy, r));
}

/**
 * The fields of a policy this person may read — for a service that builds a
 * Prisma `select` rather than filtering an already-fetched row.
 */
export function visibleFields(user: Pick<RequestUser, "permissions">, policy: FieldPolicy): string[] {
  return Object.keys(policy).filter((f) => mayRead(user, f, policy));
}
