import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { CityScopeService } from "../src/common/city-scope/city-scope.service";
import { AccessScopeService } from "../src/common/rbac/access-scope.service";
import { PROJECT_FIELD_POLICY, VENDOR_FIELD_POLICY, redact, redactAll } from "../src/common/rbac/field-policy";
import { ReadOnlyGuard } from "../src/common/guards/read-only.guard";
import {
  ACTIONS,
  DEPARTMENTS,
  ORG_WIDE_ROLES,
  READ_ACTIONS,
  RESOURCES,
  RESOURCE_DOMAINS,
  ROLES,
  domainOf,
  isOrgWide,
  isReadOnly,
  roleSpec,
} from "../src/common/rbac/model";
import type { RequestUser } from "../src/common/types";

/**
 * The access policy, tested where it is decided.
 *
 * These are deliberately tests of the MODEL rather than of live HTTP calls.
 * The model is the single thing the database, every guard and the sidebar are
 * derived from, so a rule proven here ("Admin holds no HR write") holds
 * everywhere at once — whereas an endpoint test proves one endpoint and says
 * nothing about the next one somebody adds. The endpoint-level checks live in
 * rbac.e2e-spec.ts, which needs a seeded database; these need nothing, so
 * they run on every change.
 */

const permsOf = (role: string): Set<string> => new Set(roleSpec(role)!.permissions);
const writeActions = ACTIONS.filter((a) => !READ_ACTIONS.has(a));

/** Every permission covering a domain's resources. */
const domainPermissions = (domain: keyof typeof RESOURCE_DOMAINS): string[] =>
  RESOURCE_DOMAINS[domain].flatMap((r) => ACTIONS.map((a) => `${r}:${a}`));

function user(roleNames: string[], extra: Partial<RequestUser> = {}): RequestUser {
  const permissions = new Set<string>();
  for (const r of roleNames) for (const p of roleSpec(r)?.permissions ?? []) permissions.add(p);
  return {
    id: "u1",
    workspaceId: "w1",
    name: "Test",
    username: "test",
    email: null,
    permissions,
    roleNames,
    departmentId: null,
    departmentKey: null,
    cityAccess: [],
    mustChangePassword: false,
    ...extra,
  };
}

describe("RBAC model", () => {
  describe("shape", () => {
    it("every role names a permission that exists", () => {
      const known = new Set([...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`)), "people:view_restricted", "people:view_identity"]);
      for (const role of ROLES) {
        for (const p of role.permissions) {
          expect({ role: role.name, permission: p, exists: known.has(p) }).toEqual({ role: role.name, permission: p, exists: true });
        }
      }
    });

    it("every role's department is a real department, or none", () => {
      const keys = new Set<string>(DEPARTMENTS.map((d) => d.key));
      for (const role of ROLES) {
        if (role.department) expect(keys.has(role.department)).toBe(true);
      }
    });

    it("every resource belongs to exactly one domain", () => {
      const seen = new Map<string, string>();
      for (const [domain, resources] of Object.entries(RESOURCE_DOMAINS)) {
        for (const r of resources) {
          expect(seen.get(r)).toBeUndefined();
          seen.set(r, domain);
        }
      }
      for (const r of RESOURCES) expect(domainOf(r)).toBe(seen.get(r));
    });
  });

  describe("Super Admin", () => {
    it("holds every permission", () => {
      const perms = permsOf("Superadmin");
      for (const r of RESOURCES) for (const a of ACTIONS) expect(perms.has(`${r}:${a}`)).toBe(true);
    });

    it("holds the HR tiers nobody else does", () => {
      expect(permsOf("Superadmin").has("people:view_identity")).toBe(true);
      expect(permsOf("Admin").has("people:view_identity")).toBe(false);
      expect(permsOf("People & Resources").has("people:view_identity")).toBe(false);
    });
  });

  describe("Admin", () => {
    const perms = permsOf("Admin");

    it("can read people but cannot write them — not by any action", () => {
      expect(perms.has("people:view")).toBe(true);
      for (const a of writeActions) expect({ action: a, held: perms.has(`people:${a}`) }).toEqual({ action: a, held: false });
    });

    it("cannot export people either: extraction is not reading", () => {
      expect(perms.has("people:export")).toBe(false);
    });

    it("holds everything else, including all of finance", () => {
      for (const p of domainPermissions("FINANCE")) expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
      for (const p of domainPermissions("OPERATIONS")) expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
      for (const p of domainPermissions("SALES")) expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
    });

    it("keeps HR closed even for a resource added to the HR domain later", () => {
      // The grant is stated as a subtraction, so this is a property of the
      // model rather than of the current resource list.
      const hrWrites = [...perms].filter((p) => RESOURCE_DOMAINS.HR.some((r) => p.startsWith(`${r}:`)) && !READ_ACTIONS.has(p.split(":")[1]!));
      expect(hrWrites).toEqual([]);
    });
  });

  describe("Founder", () => {
    const perms = permsOf("Founder");

    it("can view every resource", () => {
      for (const r of RESOURCES) expect({ r, held: perms.has(`${r}:view`) }).toEqual({ r, held: true });
    });

    it("holds no write permission of any kind", () => {
      const writes = [...perms].filter((p) => !READ_ACTIONS.has(p.split(":")[1]!));
      expect(writes).toEqual([]);
    });

    it("is marked read-only, and one read-only role is enough to be read-only", () => {
      expect(isReadOnly(["Founder"])).toBe(true);
      // Holding a second, writing role makes someone a writer — which is why
      // the org assignment gives the Founder exactly one role.
      expect(isReadOnly(["Founder", "Operations"])).toBe(false);
    });

    it("is org-wide: department scoping does not narrow what they see", () => {
      expect(isOrgWide(["Founder"])).toBe(true);
      expect(ORG_WIDE_ROLES).toEqual(["Superadmin", "Admin", "Founder"]);
    });
  });

  describe("Finance", () => {
    const perms = permsOf("Finance");

    it("owns every finance resource", () => {
      for (const p of domainPermissions("FINANCE")) expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
    });

    it("cannot reach HR", () => {
      for (const p of domainPermissions("HR")) expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
    });

    it("owns the client list, because they are the ones who correct it", () => {
      for (const a of ["view", "create", "edit", "delete", "export"]) {
        expect({ a, held: perms.has(`clients:${a}`) }).toEqual({ a, held: true });
      }
    });

    it("can raise and correct an event, but not delete one", () => {
      // Finance raises events that arrive straight to them, and fixes their
      // own typos. Deleting an event takes its tasks, crew, invoices and
      // purchase orders with it — that call belongs to whoever runs it.
      expect(perms.has("projects:create")).toBe(true);
      expect(perms.has("projects:edit")).toBe(true);
      expect(perms.has("projects:delete")).toBe(false);
    });

    it("reads the other operational records without editing them", () => {
      expect(perms.has("vendors:view")).toBe(true);
      expect(perms.has("vendors:edit")).toBe(false);
      expect(perms.has("inventory:view")).toBe(false);
      expect(perms.has("tasks:edit")).toBe(false);
    });
  });

  describe("People & Resources", () => {
    const perms = permsOf("People & Resources");

    it("owns people and the bartender pool", () => {
      for (const a of ACTIONS) expect({ a, held: perms.has(`people:${a}`) }).toEqual({ a, held: true });
      for (const a of ACTIONS) expect({ a, held: perms.has(`freelancers:${a}`) }).toEqual({ a, held: true });
    });

    it("cannot reach finance", () => {
      for (const p of domainPermissions("FINANCE")) expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
    });

    it("does not hold the restricted HR tiers by default", () => {
      expect(perms.has("people:view_restricted")).toBe(false);
      expect(perms.has("people:view_identity")).toBe(false);
    });
  });

  describe("bartenders are not employee records", () => {
    it("Operations manages the crew without reading a single HR record", () => {
      const perms = permsOf("Operations");
      for (const a of ACTIONS) expect({ a, held: perms.has(`freelancers:${a}`) }).toEqual({ a, held: true });
      for (const p of domainPermissions("HR")) expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
    });

    it("the two are separate resources, so neither implies the other", () => {
      expect(domainOf("freelancers")).toBe("OPERATIONS");
      expect(domainOf("people")).toBe("HR");
    });

    it("Marketing and Sales reach neither", () => {
      for (const role of ["Sales", "Marketing", "Social Media"]) {
        const perms = permsOf(role);
        expect({ role, held: perms.has("freelancers:view") }).toEqual({ role, held: false });
        expect({ role, held: perms.has("people:view") }).toEqual({ role, held: false });
      }
    });
  });

  describe("City Head", () => {
    const perms = permsOf("City Head");

    it("runs their city's events, crew, tasks, pipeline and marketing", () => {
      for (const p of ["projects:edit", "tasks:create", "freelancers:edit", "leads:edit", "clients:edit", "marketing:edit", "people:view", "reports:view"]) {
        expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
      }
    });

    it("holds no company-finance permission", () => {
      // reports:view is city-scoped, so it answers "how did MY city do".
      // Invoices, payments, budgets and expenses are not, and stay with Finance.
      for (const r of ["invoices", "payments", "budgets", "expenses"]) {
        for (const a of ACTIONS) expect({ p: `${r}:${a}`, held: perms.has(`${r}:${a}`) }).toEqual({ p: `${r}:${a}`, held: false });
      }
    });

    it("cannot edit an employee record — only Superadmin and People & Resources can", () => {
      for (const a of writeActions) expect({ a, held: perms.has(`people:${a}`) }).toEqual({ a, held: false });
    });

    it("is not org-wide: their city grant is what bounds them", () => {
      expect(isOrgWide(["City Head"])).toBe(false);
    });
  });

  describe("Sales, Marketing and Social Media", () => {
    it("Sales owns leads and clients and reaches neither finance nor HR", () => {
      const perms = permsOf("Sales");
      for (const p of domainPermissions("SALES")) expect({ p, held: perms.has(p) }).toEqual({ p, held: true });
      for (const p of [...domainPermissions("FINANCE"), ...domainPermissions("HR")]) {
        expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
      }
    });

    it("Marketing works the funnel but cannot delete a lead", () => {
      const perms = permsOf("Marketing");
      expect(perms.has("marketing:edit")).toBe(true);
      expect(perms.has("leads:edit")).toBe(true);
      expect(perms.has("leads:delete")).toBe(false);
    });

    it("none of them opens the event list — they reach an event through their task", () => {
      for (const role of ["Sales", "Marketing", "Social Media", "Creative"]) {
        expect({ role, held: permsOf(role).has("projects:view") }).toEqual({ role, held: false });
      }
      // …and every one of them can still be given a task on one.
      for (const role of ["Sales", "Marketing", "Social Media", "Creative"]) {
        expect({ role, held: permsOf(role).has("tasks:view") }).toEqual({ role, held: true });
      }
    });

    it("Social Media has marketing without the funnel or the money", () => {
      const perms = permsOf("Social Media");
      expect(perms.has("marketing:edit")).toBe(true);
      expect(perms.has("leads:view")).toBe(false);
      for (const p of [...domainPermissions("FINANCE"), ...domainPermissions("HR")]) {
        expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
      }
    });
  });

  describe("Operations and Project Manager", () => {
    it("Operations runs delivery and procurement", () => {
      const perms = permsOf("Operations");
      for (const r of ["tasks", "flows", "inventory", "purchase_requests", "vendors", "recipes"]) {
        expect({ r, held: perms.has(`${r}:edit`) }).toEqual({ r, held: true });
      }
    });

    it("Operations no longer holds the people grant", () => {
      const perms = permsOf("Operations");
      for (const p of domainPermissions("HR")) expect({ p, held: perms.has(p) }).toEqual({ p, held: false });
    });

    it("both keep the full event list for their cities", () => {
      // The regression this guards: department scoping once applied to
      // everyone, and since no event has an owning department yet, Project
      // Managers and Finance saw an empty Projects screen.
      for (const role of ["Operations", "Project Manager", "Finance"]) {
        expect({ role, held: permsOf(role).has("projects:view") }).toEqual({ role, held: true });
      }
    });

    it("neither Operations nor a PM can open company financials", () => {
      for (const role of ["Operations", "Project Manager"]) {
        const perms = permsOf(role);
        for (const p of ["reports:view", "invoices:view", "budgets:view", "payments:view", "expenses:view"]) {
          expect({ role, p, held: perms.has(p) }).toEqual({ role, p, held: false });
        }
      }
    });
  });

  describe("field-level visibility", () => {
    const ops = user(["Operations"]);
    const finance = user(["Finance"]);

    it("hides vendor banking and balances from Operations, and says which fields it hid", () => {
      const row = { id: "v1", name: "ABC Events", status: "APPROVED", bankAccountNo: "12345", openingBalance: 450000, openOrders: 450000 };
      const seen = redact(ops, VENDOR_FIELD_POLICY, row);
      expect(seen.name).toBe("ABC Events");
      expect(seen.status).toBe("APPROVED");
      expect("bankAccountNo" in seen).toBe(false);
      expect("openingBalance" in seen).toBe(false);
      expect(seen.redactedFields).toEqual(expect.arrayContaining(["bankAccountNo", "openingBalance", "openOrders"]));
    });

    it("shows the same row in full to Finance, with no redaction marker", () => {
      const row = { id: "v1", name: "ABC Events", bankAccountNo: "12345", openingBalance: 450000 };
      const seen = redact(finance, VENDOR_FIELD_POLICY, row);
      expect(seen.bankAccountNo).toBe("12345");
      expect(seen.redactedFields).toBeUndefined();
    });

    it("strips revenue and cost from an event for anyone without budgets:view", () => {
      const project = { id: "p1", name: "YPO Chattarpur", revenue: 1200000, estCost: 700000, actCost: 650000 };
      const seen = redact(user(["Project Manager"]), PROJECT_FIELD_POLICY, project);
      expect(seen.name).toBe("YPO Chattarpur");
      expect("revenue" in seen).toBe(false);
      expect("estCost" in seen).toBe(false);
      expect(redact(finance, PROJECT_FIELD_POLICY, project).revenue).toBe(1200000);
    });

    it("redacts a whole list without losing rows", () => {
      const rows = [
        { id: "a", name: "A", openingBalance: 1 },
        { id: "b", name: "B", openingBalance: 2 },
      ];
      const seen = redactAll(ops, VENDOR_FIELD_POLICY, rows);
      expect(seen.map((r) => r.id)).toEqual(["a", "b"]);
      expect(seen.every((r) => !("openingBalance" in r))).toBe(true);
    });

    it("leaves a row alone when the policy names no field it carries", () => {
      const row = { id: "x", name: "Nothing sensitive" };
      expect(redact(ops, VENDOR_FIELD_POLICY, row)).toBe(row);
    });
  });

  describe("ReadOnlyGuard", () => {
    const guard = new ReadOnlyGuard();
    const ctx = (method: string, path: string, roleNames: string[]): ExecutionContext =>
      ({ switchToHttp: () => ({ getRequest: () => ({ method, path, user: user(roleNames) }) }) }) as unknown as ExecutionContext;

    it("lets a read-only role read anything", () => {
      expect(guard.canActivate(ctx("GET", "/api/invoices", ["Founder"]))).toBe(true);
    });

    it("refuses every write, including on endpoints that carry no permission decorator", () => {
      for (const [method, path] of [
        ["POST", "/api/projects"],
        ["PATCH", "/api/tasks/abc"],
        ["DELETE", "/api/invoices/abc"],
        ["POST", "/api/sops"],
        ["PATCH", "/api/settings"],
        ["POST", "/api/dashboard/announcements"],
      ] as Array<[string, string]>) {
        expect(() => guard.canActivate(ctx(method, path, ["Founder"]))).toThrow(ForbiddenException);
      }
    });

    it("still lets them sign in, talk and clear their own notifications", () => {
      expect(guard.canActivate(ctx("POST", "/api/auth/login", ["Founder"]))).toBe(true);
      expect(guard.canActivate(ctx("POST", "/api/channels/abc/messages", ["Founder"]))).toBe(true);
      expect(guard.canActivate(ctx("POST", "/api/channels/dm", ["Founder"]))).toBe(true);
      expect(guard.canActivate(ctx("POST", "/api/notifications/read-all", ["Founder"]))).toBe(true);
    });

    it("does not restrict anybody else", () => {
      expect(guard.canActivate(ctx("POST", "/api/projects", ["Superadmin"]))).toBe(true);
      expect(guard.canActivate(ctx("POST", "/api/projects", ["Admin"]))).toBe(true);
      expect(guard.canActivate(ctx("POST", "/api/tasks", ["Operations"]))).toBe(true);
    });

    it("cannot be slipped past by dressing a write up as a chat URL", () => {
      expect(() => guard.canActivate(ctx("POST", "/api/channels/abc/messages/../../projects", ["Founder"]))).toThrow(ForbiddenException);
    });
  });

  describe("record-level scope (cross-department dependency)", () => {
    const scope = new AccessScopeService(new CityScopeService());
    const ALL_CITIES: RequestUser["cityAccess"] = [{ cityId: null, scope: "ALL" }];
    const salesPerson = user(["Sales"], { id: "sales-1", departmentId: "dept-sales", departmentKey: "SALES", cityAccess: ALL_CITIES });
    const founder = user(["Founder"], { cityAccess: ALL_CITIES });
    const pm = user(["Project Manager"], { id: "pm-1", departmentId: "dept-ops", departmentKey: "OPERATIONS", cityAccess: ALL_CITIES });

    /** The clauses of an OR, as JSON, so a fragment can be asserted on. */
    const clauses = (where: { OR?: unknown[] }) => (where.OR ?? []).map((c) => JSON.stringify(c));

    it("gives an org-wide role no OR filter at all — they see every record", () => {
      expect(scope.projectWhere(founder).OR).toBeUndefined();
      expect(scope.taskWhere(founder).OR).toBeUndefined();
    });

    it("gives anyone holding projects:view the whole list for their cities", () => {
      expect(scope.projectWhere(pm).OR).toBeUndefined();
      expect(scope.taskWhere(pm).OR).toBeUndefined();
    });

    it("reaches a departmental person only through what they are attached to", () => {
      const where = scope.projectWhere(salesPerson);
      const c = clauses(where);
      expect(c).toContain(JSON.stringify({ pmId: "sales-1" }));
      expect(c).toContain(JSON.stringify({ members: { some: { userId: "sales-1", deletedAt: null } } }));
      expect(c).toContain(JSON.stringify({ primaryDeptId: "dept-sales" }));
      // The dependency itself: a Sales task on an event Operations owns.
      expect(c).toContain(JSON.stringify({ tasks: { some: { deletedAt: null, primaryDeptId: "dept-sales" } } }));
    });

    it("hands a supporting department its own task, not the whole board", () => {
      const c = clauses(scope.taskWhere(salesPerson));
      expect(c).toContain(JSON.stringify({ primaryDeptId: "dept-sales" }));
      expect(c).toContain(JSON.stringify({ supportingDepts: { some: { departmentId: "dept-sales" } } }));
      // Nothing in the filter reaches another department's tasks on the same
      // event; the only cross-event clauses are personal ones.
      expect(c).not.toContain(JSON.stringify({}));
    });

    it("keeps city access as the outer boundary a department grant cannot cross", () => {
      const delhiOnly = user(["Operations"], {
        id: "ops-1",
        departmentId: "dept-ops",
        departmentKey: "OPERATIONS",
        cityAccess: [{ cityId: "delhi", scope: "WRITE" }],
      });
      expect(scope.projectWhere(delhiOnly)).toMatchObject({ cityId: { in: ["delhi"] } });
      // …and a dependency-only role is bounded by its cities too.
      const delhiSales = user(["Sales"], { id: "s2", departmentId: "dept-sales", cityAccess: [{ cityId: "delhi", scope: "WRITE" }] });
      expect(scope.projectWhere(delhiSales)).toMatchObject({ cityId: { in: ["delhi"] } });
    });

    it("bounds a City Head to their one city, in the query itself", () => {
      const mumbai = user(["Operations", "City Head"], {
        id: "harshita",
        departmentId: "dept-ops",
        departmentKey: "OPERATIONS",
        cityAccess: [{ cityId: "mumbai", scope: "WRITE" }],
      });
      // They hold projects:view, so they see their city's whole event list…
      expect(scope.projectWhere(mumbai)).toMatchObject({ cityId: { in: ["mumbai"] } });
      expect(scope.taskWhere(mumbai)).toMatchObject({ project: { cityId: { in: ["mumbai"] } } });
      // …and asking for another city is refused rather than silently widened.
      expect(() => scope.projectWhere(mumbai, "goa")).toThrow();
    });

    it("never falls back to every city when no city is requested", () => {
      // The leak that matters: a scoped caller who supplies no filter must
      // get THEIR cities, never an unfiltered query.
      const goa = user(["City Head"], { id: "artem", cityAccess: [{ cityId: "goa", scope: "WRITE" }] });
      const where = scope.projectWhere(goa);
      expect(where).toMatchObject({ cityId: { in: ["goa"] } });
      expect(JSON.stringify(where)).not.toContain('"cityId":{}');
    });

    it("gives somebody with no department only their own records", () => {
      const loner = user(["Employee"], { id: "e1", cityAccess: ALL_CITIES });
      expect(loner.permissions.has("projects:view")).toBe(false);
      const c = clauses(scope.taskWhere(loner));
      expect(c).toEqual([
        JSON.stringify({ ownerId: "e1" }),
        JSON.stringify({ project: { pmId: "e1" } }),
        JSON.stringify({ project: { members: { some: { userId: "e1", deletedAt: null } } } }),
      ]);
    });
  });
});
