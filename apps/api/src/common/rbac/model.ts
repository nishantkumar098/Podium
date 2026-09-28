/**
 * Podium's access model, in one place.
 *
 * WHY THIS FILE EXISTS. Permissions used to be decided in three places that
 * could disagree: the seed script's ROLE_GRANTS (run once, then drifted), a
 * `@RequirePermissions` string picked per endpoint by hand, and a `perm` on
 * each sidebar entry in AppShell. Nothing tied them together, so `/reports`
 * — the company P&L — shipped gated on `projects:view`, which every Project
 * Manager holds. This module is the single declaration the database, the API
 * and the sidebar are all synced against.
 *
 * The model is deliberately data, not code:
 *
 *   Role        one primary label per person (plus any extra roles they hold)
 *   Department  which part of the business they sit in
 *   City        which cities they may act in (UserCityAccess, unchanged)
 *   Permission  "<resource>:<action>", the only thing a guard ever checks
 *   Domain      which part of the business a resource belongs to, so
 *               "finance data is Finance-only" is one rule, not forty
 *
 * Nothing here checks an e-mail address or a person's name. Naming a role
 * after a person ("Nishant is Admin") is an assignment, made by
 * `scripts/sync-rbac.ts`, never a branch in application code.
 */

// ---------------------------------------------------------------- actions

/** Every action a permission can carry. view/export read; the rest write. */
export const ACTIONS = ["view", "create", "edit", "delete", "approve", "export"] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions that only read. A read-only role may hold these and nothing else. */
export const READ_ACTIONS: ReadonlySet<string> = new Set(["view", "export"]);

// ------------------------------------------------------------ departments

/**
 * The business's departments. Adding one here (plus a role below) is the
 * whole job — no guard, table or migration changes.
 */
export const DEPARTMENTS = [
  { key: "LEADERSHIP", name: "Leadership" },
  { key: "FINANCE", name: "Finance" },
  { key: "HR", name: "HR" },
  { key: "SALES", name: "Sales" },
  { key: "MARKETING", name: "Marketing" },
  { key: "SOCIAL_MEDIA", name: "Social Media" },
  { key: "OPERATIONS", name: "Operations" },
  { key: "CREATIVE", name: "Creative" },
] as const;
export type DepartmentKey = (typeof DEPARTMENTS)[number]["key"];
export const DEPARTMENT_KEYS: readonly DepartmentKey[] = DEPARTMENTS.map((d) => d.key);

/**
 * Free-text `User.dept` values as AMM's own data writes them, mapped onto a
 * department key. Used once, by the backfill in `scripts/sync-rbac.ts`;
 * after that `User.departmentId` is the answer and this is only a fallback
 * for a row nobody has classified yet.
 */
export function departmentFromText(text: string | null | undefined): DepartmentKey | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/hr|human/.test(t)) return "HR";
  if (/financ|account/.test(t)) return "FINANCE";
  if (/social/.test(t)) return "SOCIAL_MEDIA";
  if (/market/.test(t)) return "MARKETING";
  if (/sales|business dev/.test(t)) return "SALES";
  if (/creative|design|content/.test(t)) return "CREATIVE";
  if (/ops|operation|production|logistic|procure|bar|store|event/.test(t)) return "OPERATIONS";
  if (/leader|founder|director|management/.test(t)) return "LEADERSHIP";
  return null;
}

// -------------------------------------------------------------- resources

/**
 * Every resource, grouped by the part of the business that owns it. The
 * grouping is what lets "finance data is visible to Finance, Admin,
 * Superadmin and the Founder" be one rule rather than one per screen.
 */
export const RESOURCE_DOMAINS = {
  FINANCE: ["invoices", "payments", "budgets", "expenses", "reports"],
  HR: ["people"],
  SALES: ["leads", "clients"],
  MARKETING: ["marketing"],
  OPERATIONS: [
    "projects",
    "tasks",
    "flows",
    "inventory",
    "purchase_requests",
    "vendors",
    "recipes",
    "products",
    "risks",
    "licences",
    "playbooks",
    "documents",
    "approvals",
    // Bartenders. Separated from `people` on purpose: booking and tasking
    // the freelance crew is Operations' daily work, while an employee's HR
    // record is not theirs to read. One resource could not express both.
    "freelancers",
  ],
  SYSTEM: ["settings", "automation", "audit_logs"],
} as const satisfies Record<string, readonly string[]>;

export type Domain = keyof typeof RESOURCE_DOMAINS;

export const RESOURCES: readonly string[] = Object.values(RESOURCE_DOMAINS)
  .flatMap((rs) => [...rs])
  .sort();

const DOMAIN_OF = new Map<string, Domain>(
  (Object.entries(RESOURCE_DOMAINS) as Array<[Domain, readonly string[]]>).flatMap(([d, rs]) => rs.map((r) => [r, d] as [string, Domain])),
);

/** Which domain a resource belongs to. An unknown resource is treated as SYSTEM, the most restricted. */
export function domainOf(resource: string): Domain {
  return DOMAIN_OF.get(resource) ?? "SYSTEM";
}

/**
 * Permissions that are not a plain resource x action pair. They exist
 * because what they gate is finer-grained than a screen: the two HR tiers
 * from `data-classification.ts`, held by nobody, by design.
 */
export const EXTRA_PERMISSIONS = ["people:view_restricted", "people:view_identity"] as const;

/** Every permission string the system knows about. */
export function allPermissions(): string[] {
  return [...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`)), ...EXTRA_PERMISSIONS].sort();
}

// ------------------------------------------------------------------ roles

const full = (...resources: string[]) => resources.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`));
const read = (...resources: string[]) => resources.flatMap((r) => [`${r}:view`, `${r}:export`]);
const some = (resource: string, ...actions: Action[]) => actions.map((a) => `${resource}:${a}`);

/**
 * HR writes. Admin must never hold any of these: the policy is explicit
 * that a generic "full access" grant must not quietly include employee
 * records. Stated as a subtraction below, so an HR resource added later is
 * closed to Admin automatically instead of being opened by default.
 */
export const HR_WRITE_PERMISSIONS: readonly string[] = [
  ...RESOURCE_DOMAINS.HR.flatMap((r) => ACTIONS.filter((a) => !READ_ACTIONS.has(a)).map((a) => `${r}:${a}`)),
  ...EXTRA_PERMISSIONS,
];

/** Exporting HR data is extraction, not reading: it stays with HR and Superadmin. */
const HR_EXPORT = "people:export";

export interface RoleSpec {
  readonly name: string;
  readonly description: string;
  /** The department this role belongs to, or null for roles that sit outside one. */
  readonly department: DepartmentKey | null;
  /** True when the role may only read — enforced by its grants AND centrally by ReadOnlyGuard. */
  readonly readOnly?: boolean;
  readonly permissions: readonly string[];
}

/**
 * The roles, and exactly what each may do: the three organisation-wide roles
 * first, then one role per department, then the cross-cutting delivery
 * roles, then the two external portal roles.
 */
export const ROLES: readonly RoleSpec[] = [
  {
    name: "Superadmin",
    description: "Highest authority. Sees and may change everything, including roles, departments and city access.",
    department: "LEADERSHIP",
    permissions: allPermissions(),
  },
  {
    name: "Admin",
    description: "Runs the business day to day. Everything except editing people/HR records, which stay read-only.",
    department: "LEADERSHIP",
    permissions: allPermissions().filter((p) => !HR_WRITE_PERMISSIONS.includes(p) && p !== HR_EXPORT),
  },
  {
    name: "Founder",
    description: "Organisation-wide visibility, read-only. Sees every department, city and record; changes none of them.",
    department: "LEADERSHIP",
    readOnly: true,
    permissions: read(...RESOURCES).filter((p) => p !== HR_EXPORT),
  },

  // --- one role per department -------------------------------------------
  {
    name: "Finance",
    description: "Owns money: invoices, payments, budgets, expenses and financial reporting.",
    department: "FINANCE",
    permissions: [
      ...full(...RESOURCE_DOMAINS.FINANCE),
      ...some("approvals", "view", "approve"),
      // Finance owns the client list. They are the ones who find out a
      // company has been invoiced under two slightly different names, or
      // that a "client" was only ever an enquiry — so they can add, correct
      // and remove entries rather than asking Sales to do it for them.
      // Deleting is guarded server-side: a client with live projects or
      // invoices is refused, not hidden.
      ...some("clients", "view", "create", "edit", "delete", "export"),
      // Finance raises events too — a booking that arrives straight to them,
      // or one that needs to exist before it can be invoiced. Create and
      // edit, but NOT delete: removing an event takes its tasks, crew,
      // invoices and purchase orders with it, and that call belongs to
      // whoever is running the event.
      ...some("projects", "view", "create", "edit", "export"),
      ...read("products", "vendors", "purchase_requests", "documents"),
    ],
  },
  {
    name: "People & Resources",
    description: "Owns people and resourcing: employee records, attendance, leave, the bartender pool and who is free when.",
    department: "HR",
    permissions: [
      ...full("people", "freelancers"),
      ...some("documents", "view", "create", "edit", "export"),
      ...some("tasks", "view", "edit"),
      ...some("approvals", "view", "approve"),
    ],
  },
  {
    name: "Sales",
    description: "Owns the pipeline: leads, clients, proposals and business development.",
    department: "SALES",
    // No projects:view. Sales reaches an event through the task raised for
    // them on it — which carries the event and client names — not through
    // the event list. That is the cross-department dependency rule: enough
    // to do the work, not the whole event. See access-scope.service.ts.
    permissions: [...full("leads", "clients"), ...read("marketing", "products", "documents"), ...some("tasks", "view", "edit")],
  },
  {
    name: "Marketing",
    description: "Owns campaigns and marketing analytics; works the top of the lead funnel.",
    department: "MARKETING",
    permissions: [
      ...full("marketing"),
      ...some("leads", "view", "create", "edit", "export"),
      ...read("clients", "products"),
      ...some("documents", "view", "create", "export"),
      ...some("tasks", "view", "edit"),
    ],
  },
  {
    name: "Social Media",
    description: "Owns social content and scheduling — marketing, without the funnel.",
    department: "SOCIAL_MEDIA",
    permissions: [
      ...some("marketing", "view", "create", "edit", "export"),
      ...read("clients"),
      ...some("documents", "view", "create"),
      ...some("tasks", "view", "edit"),
    ],
  },
  {
    name: "Operations",
    description: "Owns delivery: events, procurement, vendors, stock and on-ground execution.",
    department: "OPERATIONS",
    // Deliberately no `people:*`. Operations used to hold the full people
    // grant, which made every employee record readable by the delivery team.
    permissions: [
      ...full("tasks", "flows", "inventory", "purchase_requests", "vendors", "recipes", "products", "risks", "freelancers"),
      ...some("projects", "view", "edit", "export"),
      ...some("documents", "view", "create", "edit", "export"),
      ...some("approvals", "view", "create", "approve"),
      ...read("licences", "playbooks", "clients", "leads"),
    ],
  },
  {
    name: "Creative",
    description: "Design and content for events and campaigns.",
    department: "CREATIVE",
    permissions: [
      ...some("tasks", "view", "edit"),
      ...some("documents", "view", "create"),
      ...read("marketing"),
      "flows:view",
      "approvals:approve",
    ],
  },

  // --- cross-cutting delivery roles --------------------------------------
  {
    name: "City Head",
    description: "Runs one city end to end: its events, crew, tasks, pipeline and marketing. City access is what limits them, not the role.",
    department: "OPERATIONS",
    /**
     * Broad BY DESIGN — a City Head is meant to see everything about their
     * city. What stops that being everything about the company is
     * UserCityAccess: a City Head holds exactly one city, so every query
     * CityScopeService touches is already narrowed before this role's
     * permissions are consulted. The permission says "which kinds of
     * record"; the city grant says "whose".
     *
     * The company's money is the deliberate exception. They get
     * `reports:view` — which is city-scoped, so it answers "how did MY city
     * do" — but no invoices, payments, budgets or expenses. Those are
     * Finance's, and are not city-scoped in a way that would hold.
     */
    permissions: [
      ...full("projects", "tasks", "flows", "risks", "freelancers"),
      ...some("documents", "view", "create", "edit", "export"),
      ...some("approvals", "view", "create", "approve"),
      ...some("leads", "view", "create", "edit", "export"),
      ...some("clients", "view", "create", "edit", "export"),
      ...some("marketing", "view", "create", "edit", "export"),
      ...some("inventory", "view", "create", "edit", "export"),
      ...read("people", "vendors", "purchase_requests", "recipes", "products", "licences", "playbooks", "reports"),
    ],
  },
  {
    name: "Project Manager",
    description: "Runs individual events end to end. Operational scope; no company financials.",
    department: "OPERATIONS",
    // No `invoices:view` or `budgets:view`: a PM's own event economics reach
    // them through the redacted project record, not the company's money
    // screens. See field-policy.ts.
    permissions: [
      ...full("projects", "tasks", "flows", "documents", "risks"),
      ...some("approvals", "view", "create", "approve"),
      ...read("playbooks", "products", "clients", "leads", "licences", "vendors"),
    ],
  },
  {
    name: "Employee",
    description: "Baseline access for everyone: their own work, the flows they sit in, shared documents and chat.",
    department: null,
    permissions: [...some("tasks", "view", "edit"), "flows:view", "documents:view"],
  },

  // --- external portal roles ---------------------------------------------
  {
    name: "Client",
    description: "External client portal: their own invoices, documents and approvals.",
    department: null,
    permissions: ["invoices:view", "documents:view", "approvals:view", "approvals:approve"],
  },
  {
    name: "Vendor",
    description: "External vendor portal: their own purchase orders, documents and payments.",
    department: null,
    permissions: ["invoices:view", "documents:view", "payments:view"],
  },
];

export const ROLE_NAMES: readonly string[] = ROLES.map((r) => r.name);

const ROLE_BY_NAME = new Map(ROLES.map((r) => [r.name, r]));
export function roleSpec(name: string): RoleSpec | undefined {
  return ROLE_BY_NAME.get(name);
}

/** Roles that may only read. */
export const READ_ONLY_ROLES: readonly string[] = ROLES.filter((r) => r.readOnly).map((r) => r.name);

/** The roles with unrestricted reach, for checks that are about authority rather than a resource. */
export const TOP_ROLE_NAMES: readonly string[] = ["Superadmin", "Founder"];

/**
 * Roles whose remit is the whole organisation rather than one department.
 * They are exempt from department scoping — never from city scoping, and
 * never from a permission check: the Founder is org-wide AND read-only.
 */
export const ORG_WIDE_ROLES: readonly string[] = ["Superadmin", "Admin", "Founder"];

/** Does this person hold a role whose remit is the whole organisation? */
export function isOrgWide(roleNames: readonly string[]): boolean {
  return roleNames.some((r) => ORG_WIDE_ROLES.includes(r));
}

/** Is every role this person holds read-only? One writing role is enough to make them a writer. */
export function isReadOnly(roleNames: readonly string[]): boolean {
  return roleNames.length > 0 && roleNames.every((r) => READ_ONLY_ROLES.includes(r));
}

/** The role someone joining a department gets by default. */
export function defaultRoleForDepartment(dept: DepartmentKey): string {
  const orgWide = new Set(["Superadmin", "Admin", "Founder"]);
  return ROLES.find((r) => r.department === dept && !orgWide.has(r.name))?.name ?? "Employee";
}
