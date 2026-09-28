# Access control

Who sees what in Podium, and where each rule is enforced.

## The five things an authorization decision uses

```
User → Role → Department → City → Record attachment → Resource + action → Fields
```

Nothing in application code checks a person's name or e-mail. Naming somebody
to a role is an assignment made by `scripts/sync-rbac.ts`; the rules
themselves are data.

| Layer | Where it lives | What it decides |
| --- | --- | --- |
| Role → permissions | `apps/api/src/common/rbac/model.ts` | what each role may do |
| Permission check | `common/guards/permissions.guard.ts` + `@RequirePermissions` | may you call this endpoint |
| Read-only roles | `common/guards/read-only.guard.ts` | may you write **anything** |
| City scope | `common/city-scope/city-scope.service.ts` | which cities' rows |
| Record scope | `common/rbac/access-scope.service.ts` | which events and tasks |
| Field scope | `common/rbac/field-policy.ts` | which columns of a row you may read |
| People tiers | `common/data-classification.ts` | compensation and identity data |
| Sidebar + route guard | `apps/web/components/AppShell.tsx` | what is offered, and a plain refusal |

The frontend layer is an explanation, never the control. Every rule above it
is enforced server-side, so changing a URL, replaying a request or calling an
endpoint the sidebar never showed you gets you nothing.

## Who holds what

| Person | Role | Cities | Reach |
| --- | --- | --- | --- |
| Archit Singhal | Superadmin | all | everything |
| Nishant Kumar | Superadmin | all | everything |
| Anant | Superadmin | all | everything |
| Zumair, Shweta | Finance | all | money; no HR, no crew |
| Kumkum, Archi | People & Resources | all | employees, attendance, leave, the crew pool |
| Yashwant, Shobhit, Puran, Manish | Operations | own / all | delivery, procurement, tasks, bartenders |
| Amit | Operations + City Head | Dehradun | everything in Dehradun |
| Harshitha | Operations + City Head | Mumbai | everything in Mumbai |
| Artem | City Head | Goa | everything in Goa |
| Dennis, Davina | City Head | Chennai | everything in Chennai |
| Aastha, Aryan, Riya, Rohit | Sales + Marketing | own | pipeline, clients, campaigns |

The table lives in code, at `ASSIGNMENTS` in `scripts/sync-rbac.ts`. Nothing
in the application checks a name or an e-mail address.

### The three roles that are not a department

| Role | Reads | Writes |
| --- | --- | --- |
| **Superadmin** | everything | everything |
| **Admin** | everything | everything **except people/HR records** |
| **Founder** | everything | nothing |

Admin's grant is written as a subtraction — every permission, minus HR
writes — so a new HR resource is closed to Admin automatically instead of
being opened by a generic "full access".

The Founder role is read-only twice over: it holds no write permission at
all, *and* `ReadOnlyGuard` refuses every unsafe HTTP method regardless of
which endpoint it lands on. The second belt matters because several routes
are deliberately authenticated-only and carry no permission decorator.

**Nobody currently holds Admin or Founder.** All three of the people who
used to are Superadmin, by instruction. Both roles remain defined and
enforced, so assigning one is a one-line change to `ASSIGNMENTS`.

## City Heads

A City Head's role is broad on purpose — events, crew, tasks, pipeline,
marketing, their city's reports. What bounds it is not the role but
`UserCityAccess`: they hold exactly one city, so every scoped query is
narrowed before their permissions are consulted. The permission says which
*kinds* of record; the city grant says *whose*.

Asking for another city is refused, not silently widened, and omitting the
city falls back to their own — never to all of them. That second half is the
one that matters, because "no filter supplied" is how scoped data usually
leaks.

The company's money is the deliberate exception: a City Head gets
`reports:view`, which is city-scoped and answers "how did my city do", but
no invoices, payments, budgets or expenses.

## Leads are not city-scoped

Everything else in Podium is. A lead is the exception, because it is not yet
anybody's work — it is an enquiry that arrived, often with no city at all, or
with one nobody has mapped yet ("Gurgaon", "NCR", "near Manesar").

Under city scoping those leads were invisible to everyone except all-cities
users, which is how **11,911 of 12,756 leads** became unreachable by the
Sales team meant to work them. An enquiry nobody can see is a lost sale, and
losing it to an access rule is worse than losing it to a competitor.

So the pipeline is a company-wide pool: anyone holding `leads:view` sees
every lead, from every city and every source. The permission still decides
*whether* you see leads at all — Finance and People & Resources get nothing.

The city boundary returns the moment a lead becomes real work. `convert()`
still refuses to create a project in a city the caller has no access to,
because a project **is** somebody's work and does belong to a city.

## Bartenders are not employee records

The freelance crew has its own resource, `freelancers`, separate from
`people`. Booking and tasking bartenders is Operations' daily work; an
employee's HR file is not theirs to read, and one resource could not express
both. `/freelancers` is the crew pool; `/people` still shows both to
whoever may see both.

## Departments

`Finance · HR · Sales · Marketing · Social Media · Operations · Creative ·
Leadership` — rows in the `departments` table, not an enum, so a new one
needs no migration. Each department has a role of the same name; a person
has one department (`User.departmentId`), and their chat group follows it.

Domains group resources so the money and people rules are each a single
statement:

- **Finance** — invoices, payments, budgets, expenses, reports
- **HR** — people
- **Sales** — leads, clients
- **Marketing** — marketing
- **Operations** — projects, tasks, flows, inventory, purchase requests, vendors, recipes, products, risks, licences, playbooks, documents, approvals, freelancers (bartenders)
- **System** — settings, automation, audit logs

## Cross-department dependencies

`projects:view` is the dividing line.

**Roles that run events** — Operations, Project Manager, Finance and the
three organisation-wide roles — hold it and see every event in their cities.
What they may read *of* each event is then decided by field policy, below.

**Roles that do not** — Sales, Marketing, Social Media, Creative, HR,
Employee — never open the event list. They reach an event only through a task
raised for them on it, and the task carries the event and client names they
need to do the work.

So when Operations raises "prepare the client proposal" on their event and
marks it Sales, Sales gets that one task and the event's name. They do not
become crew, they do not get the event's other tasks, and the vendor payment,
margin and HR sections never reach them at all.

An event may also name a department as its owner or as supporting it, which
widens that reach to the whole department rather than one assignee.

## Field-level visibility

Page permissions cannot express "Operations may see that ABC Events is
confirmed and owes us 500 chairs, but not that we are paying them
₹4,50,000" — both facts sit on one row. `field-policy.ts` names the
sensitive columns and the permission each needs, and the service removes
them before the row leaves the server. Removed, not nulled: an empty value
would read as "no bank details on file".

| Record | Closed fields | Needs |
| --- | --- | --- |
| Project | revenue, estCost, actCost, margin | `budgets:view` |
| Vendor | bank details, PAN, UPI, opening balance, payment dates, open orders | `payments:view` |
| Home dashboard | booked revenue | `budgets:view` |

A purchase order's own total is deliberately *not* closed to Operations:
raising and negotiating it is their job.

## Chat

Available to everyone. Company, city and department groups are derived from
the person's profile rather than from membership rows — move someone from
Delhi to Jaipur, or Sales to Marketing, and their groups move with them.
Direct messages and custom groups are members-only, and no amount of city or
department access opens them.

## Changing the rules

1. Edit `apps/api/src/common/rbac/model.ts`.
2. `pnpm rbac:sync` — prints every grant and revoke, writes nothing.
3. `pnpm rbac:sync -- --apply` — writes them.

Signed-in users pick up the change within a minute (`JwtStrategy` caches
resolved identities for 60 s).

Tests: `apps/api/test/rbac-model.e2e-spec.ts` proves the policy itself and
needs no database; `apps/api/test/rbac.e2e-spec.ts` proves it over HTTP and
needs the seeded test database.
