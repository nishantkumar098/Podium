# Podium v2 (AMM Brands LLP) — Production Architecture Blueprint
*Prepared for direct hand-off to an engineering agent (Claude Code). Source of truth: `docs/prototype/podium-v2-amm-brands.html` (single-file JS prototype, ~3,340 lines, in-memory state, no backend).*

Legend used throughout: **[EXISTING]** = present in the prototype today · **[REQUIRED]** = must exist for production, implied by existing behavior · **[RECOMMENDED]** = CTO improvement, not asked for but needed · **[FUTURE]** = defer past V1.

---

## 1. Executive CTO Assessment

The prototype is a single static HTML file with ~30 in-memory JS arrays (`CLIENTS`, `PROJECTS`, `VENDORS`, `TASKS`, `INV`, `INVOICES`, `FLOWS`, …) rendered by hand-written DOM string templates, with a client-side router (`data-view`) and a hash-free SPA shell. There is no server, no auth, no persistence — refreshing the page resets the world. That is fine for a prototype and is *not* a criticism of the product thinking, which is unusually complete: it already encodes a real operating model for a multi-city events/bar business (leads → projects → flows → inventory → invoicing → P&L), a genuine workflow/handoff engine (`FLOW_TEMPLATES`, dependency graph, SLA per step), city-scoped GST-aware invoice numbering, and ledger-shaped inventory movements.

**Verdict:** the product vision is sound and specific to AMM Brands' actual business (bartending/events across Jaipur, Udaipur, Delhi, Mumbai, Bengaluru, Goa). The engineering behind it is 100% throwaway — every array becomes a normalized table, every `TASKS.push(...)` becomes an authorized, audited API call, and the flow engine becomes a real state machine instead of an array mutation. Nothing here needs a generic rewrite; it needs the exact same screens, wired to a real backend.

**Top 5 risks in the current design, once real money and real licences are involved:**
1. **No auditability of financial or inventory mutations** — `INVOICES`, `MOVES`, `ALLOC` are plain arrays anyone in the browser console could edit. Production requires an append-only ledger for both (§21, §60).
2. **No GST breakdown on invoices** — `INVOICES[].items` only has description/qty/rate; there's no CGST/SGST/IGST/HSN split despite the invoice number already encoding state (`AMM/UDR/26-27/0012`). This is a compliance gap, not a nice-to-have (§22).
3. **Flow step ownership is a single user ID** — no delegation, no reassignment on leave, no SLA breach handling beyond the demo `JUST_UNLOCKED` highlight (§12/§6).
4. **RBAC is a description string** (`ROLES[].perms` is free text) — there is no enforcement anywhere, client or server (§11).
5. **City scope (`CITY_SCOPE`) filters arrays in the browser** — in production this must become a mandatory server-side query predicate, not a UI convenience (§10).

None of these are hard problems; they're exactly what "prototype → production" means. The rest of this document is the concrete plan.

---

## 2. Prototype Reverse Engineering

### 2.1 Navigation map (from `data-view` router, 33 screens)
`dashboard` · `mywork` · `flows` · `projects` · `tasks` · `timeline` · `chat` · `mail` · `calendar` · `meetings` · `eventday` · `resources` · `risks` · `inventory` · `recipes` · `procurement` · `vendors` · `crm` · `clients` · `invoices` · `finance` · `pnl` · `expenses` · `people` · `compliance` · `approvals` · `documents` · `reports` · `knowledge` · `automation` · `audit` · `settings` · `whatsnew`

### 2.2 Per-screen reverse-engineering
See `docs/screens.md` for the full 33-row table (this document originally sampled 13 of 33; screens.md now covers all of them, per §46/47).

### 2.3 Data structures found in the prototype (confirmed by direct inspection)
`CLIENTS, PROJECTS, VENDORS, LEADS, CRM_STAGES, TASKS, STATUS_COLS, RISKS, APPROVALS, DOCUMENTS, ACTIVITY, NOTIFICATIONS, SOPS, AUTOMATIONS, ROLES, TEAM, TEAM_CITY, CITIES, CITY_SCOPE, CURRENT_USER, PRESENCE, BOT, CHANNELS, MSGS, READ, MAIL_FOLDERS, EMAILS, MAIL_TEMPLATES, MEET_CODES, MEET_ITEMS, MEETINGS, FLOW_TEMPLATES, FLOWS, JUST_UNLOCKED, INV, INV_CATS, MOVES, ALLOC, RECIPES, PURCHASE_REQUESTS, EXPENSES, INVOICES, PNL_CFG, PNL_MONTHS, PNL_PERIODS, LICENCES, RUNSHEETS, RUNSTATE, CHECKINS, INCIDENTS, FREELANCERS, ATTEND, LEAVES, AUDIT, WHATS_NEW, EXT_VIEWS, PROJ_TABS, VIEW_TITLES, CMDK_INDEX`.

Every table in §9's schema traces back to one of these — nothing in this blueprint is invented functionality.

---

## 3. Product Architecture

Podium is a **single connected operating system**, not a suite. The prototype already encodes the intended spine:

```
Lead → Opportunity → Client → Quotation → Won → Project (from Playbook)
  → Tasks + Flows generated → Budget → Procurement → Resources
  → Inventory reservation → Compliance → Client approvals
  → Production planning → Event Day → Closure → Invoice → Collection
  → Project P&L → Post-event review → Knowledge capture
```

Architectural principle carried through every section below: **every module reads and writes through one API layer and one Postgres database; there is no module-local data.** `EMAILS.link = {proj, client}` and `CHANNELS` auto-created per project already show the prototype's own instinct toward this — production just makes it a foreign key instead of a loosely-typed pointer.

## 4. Module Architecture

Grouped exactly as the prototype's own sidebar groups them (Core / Operations / Revenue & Money / People & Governance / System), each module becomes a bounded context with its own tables but shared identity, city-scope, and audit:

- **Core:** Dashboard, My Work, Projects, Tasks, Timeline, Flows, Chat, Mail, Calendar, Meetings
- **Operations:** Event Day, Resources, Risks & Issues, Inventory, Menu Costing, Procurement, Vendors
- **Revenue & Money:** CRM/Pipeline, Clients, Invoices, P&L, Project Finance, Expenses
- **People & Governance:** People, Compliance, Approvals, Documents, Reports
- **System:** Knowledge/SOPs, Automation, Audit Log, Settings, Integrations

## 5. End-to-End Business Workflows

Two workflows matter most and must be modeled as first-class state machines, not screens:

**A. Deal → Project (already an automation in the prototype: `au1` "Deal Won → Project Auto-Creation")**
`Lead(stage=Won)` → trigger → select `Playbook` by project type → create `Project` + `project_stages` + `tasks` (from playbook defaults) + `flow_instances` (from playbook's default flow templates) + client folder (`documents` root) + Slack/chat `project channel` (mirrors `CHANNELS` auto-creating `proj-p1` style channels) + notify Ops.

**B. Flow handoff (the prototype's actual differentiator — `instantiateFlow`, step `deps`, `JUST_UNLOCKED`)**
Step `done` → engine checks every other step whose `deps` includes it → if all deps of a dependent step are now done, dependent transitions `locked → ready` → notify new owner (in-app + chat DM from "Podium Bot", matching `BOT` + `notify()` in the prototype) → post to project channel → start SLA timer.

## 6. Flow Engine

**State machine** (superset of the prototype's `locked/ready/active/done`, adding what production needs):

```
DRAFT → READY → ACTIVE → COMPLETED
                 ├──→ BLOCKED ──→ ACTIVE (unblocked)
                 ├──→ ESCALATED (SLA breached) ──→ ACTIVE / REASSIGNED
                 ├──→ CANCELLED
                 └──→ FAILED
LOCKED (deps unmet) → READY (all deps COMPLETED)
```

- **Transitions are server-authoritative.** A step can only move `READY→ACTIVE` when its actor calls `POST /flow-steps/:id/start`, and `ACTIVE→COMPLETED` via `POST /flow-steps/:id/complete`, each checked against role + assignment.
- **Join logic:** a step becomes `READY` only when *every* dependency step is `COMPLETED` (AND-join, as in `ft1`'s step `f` depending on `['c','e']`). Production adds OR-join and parallel fan-out as configurable per-dependency-edge attributes — not present in the prototype but required once playbooks get more complex (e.g., "either compliance OR client sign-off" gates).
- **SLA (`sla` field, in minutes, already in `FLOW_TEMPLATES`):** a scheduled job checks `now() > readyAt + sla` → marks `ESCALATED`, notifies the step owner's manager (role above them in `TEAM`), and raises a project risk (mirrors `au2` Task Overdue Escalation pattern, generalized to flow steps).
- **Reassignment:** manual (PM/Ops re-points `owner`) and automatic (owner on approved `LEAVES` → auto-reassign to same-role backup, configurable per playbook).
- Every transition writes a `flow_step_runs` row (immutable) — this *is* the audit trail for the flow engine, and doubles as the analytics source for "bottleneck identification" (§52).

## 7. Event Business Architecture

The lifecycle in §3 is the backbone; the concrete state fields already exist per entity and just need enforcement:
`leads.stage ∈ CRM_STAGES` (`Lead, Qualified, Proposal, Negotiation, Won`) → `projects.status` (`Planning, In Progress, On Hold, Completed, Cancelled` — prototype only shows `In Progress` seed data, full enum defined in §9) → `projects.health ∈ {green, amber, red}` (already computed ad hoc in the dashboard; production computes it from a rule: overdue tasks, open critical risks, days-to-event, budget variance) → Event Day (`RUNSHEETS`/`RUNSTATE`/`CHECKINS`/`INCIDENTS`) → `invoices` → `payments` → `project P&L` (revenue − actCost, already tracked per project: `revenue, estCost, actCost, paid`) → Knowledge capture (`SOPS`/`knowledge_documents`, new SOP proposed from post-event review).

## 8. Technology Stack

| Layer | Choice | Why | Trade-off |
|---|---|---|---|
| Frontend | **Next.js 14 (App Router) + React + TypeScript** | Matches the prototype's server-renderable page-per-module shape (`data-view` ≈ route), SSR for the dashboard, good SEO-irrelevant here but great DX | Heavier than the prototype's raw HTML; justified once real auth/permissions exist |
| Design system | Tailwind + a small custom component library that **codifies the existing visual language** — dark sidebar, warm paper background, brass/gold accent, IBM Plex Sans/Mono, Lora display type, status pills, command palette | Preserves brand and the UX AMM already validated internally | None — this is a straight port, not a redesign |
| State/data fetching | TanStack Query + Zod-validated API client | Server is the source of truth everywhere (fixes the prototype's biggest flaw) | Slightly more boilerplate than raw fetch |
| Backend | **Node.js + TypeScript**, NestJS (modular, matches the "module = bounded context" structure in §4) | One language across stack; team can move fast; NestJS's module/guard system maps directly to RBAC | Not as fast as Go/Rust for CPU-bound work, irrelevant at this scale |
| Database | **PostgreSQL 16** | Relational integrity for money/inventory ledgers is non-negotiable; JSONB for flexible fields (playbook config, flow step definitions) | None credible at this scale |
| ORM | Prisma | Type-safe schema-as-code, good migration story | Less flexible than raw SQL for very complex reporting queries — use raw SQL/materialized views for P&L (§23) |
| Queue/jobs | Redis + BullMQ | SLA timers, automation engine, notification fan-out, email sync all need reliable background jobs | Requires running Redis; acceptable |
| Realtime | Postgres LISTEN/NOTIFY → WebSocket gateway (NestJS Gateway), or Supabase Realtime if hosted there | Chat, flow handoffs, event-day, presence all need push updates | At >10k concurrent connections, revisit (dedicated realtime service) — not needed at AMM's scale |
| Search | Postgres full-text (`tsvector`) + trigram for V1; Meilisearch/Typesense only if search quality demands it later | Command palette + global search across ~10 entity types is well within Postgres FTS capability at this data volume | Revisit only post-PMF |
| File storage | S3-compatible object storage (AWS S3 or Cloudflare R2) | Documents, invoices PDFs, event-day photos | — |
| Auth | Auth.js / custom OAuth2+session, Google OAuth for Gmail/Calendar scope reuse | Matches Gmail/Meet integration requirement directly | — |
| Infra | AWS (RDS Postgres, ECS Fargate or a PaaS like Railway/Render for V1 to move fast), Cloudflare in front | Predictable, boring, well-understood | Cost slightly higher than raw EC2; worth it pre-Series-anything |
| Email delivery | Gmail API (bidirectional sync, per §16) + Postmark/SES for transactional (invoice emails, password resets) | Gmail API ≠ transactional sender; keep them separate | — |

## 9. Database Architecture (core schema)

Every table below traces to a prototype array named in parentheses. All tables get: `id uuid pk`, `city_id fk` (where applicable), `created_at`, `updated_at`, `created_by fk users`, `updated_by fk users`, `deleted_at` (soft delete). Omitted below for brevity but **mandatory** on every table.

| Table | Purpose | Key fields (beyond standard) | Relationships |
|---|---|---|---|
| `workspaces` | Tenant root (AMM Brands today; multi-tenant-ready) | name, gstin | 1—N everything |
| `cities` (`CITIES`) | Operating city | name, code, state_code (GST), is_hq | 1—N projects/inventory_locations/invoices |
| `users` (`TEAM`) | Staff/founder accounts | name, email, dept, primary_role_id, primary_city_id | N—N roles |
| `roles` (`ROLES`) | Named role | name, description | N—N permissions |
| `permissions` | Atomic capability | resource, action (view/create/edit/delete/approve/export) | N—N roles |
| `user_city_access` | Which cities a user may act in | user_id, city_id, scope(read/write) | enforces §10 |
| `clients` (`CLIENTS`) | Client master | name, type(individual/corporate/brand), city_id, ltv, since | 1—N projects, contacts |
| `client_contacts` | **[REQUIRED]** — prototype only has one `contact` string | client_id, name, phone, email, role | — |
| `leads` (`LEADS`) | Pipeline entry | name, stage(enum `CRM_STAGES`), value, owner_id, city_id | converts → clients+projects |
| `vendors` (`VENDORS`) | Vendor master | name, category, city_id, rating, gstin, status(preferred/approved/blacklisted) | 1—N POs, GRNs |
| `vendor_contacts` | **[REQUIRED]** | vendor_id, name, phone, email | — |
| `playbooks` (**[REQUIRED]**, §8) | Reusable project blueprint | name, event_type, default_stages jsonb, default_tasks jsonb, default_flow_template_ids[] | 1—N projects |
| `projects` (`PROJECTS`) | Core project record | name, client_id, playbook_id, type, city_id, event_date, pm_id, status(enum), health(enum, **computed**, see §7), revenue, est_cost, act_cost | 1—N tasks/flows/invoices/expenses/risks |
| `project_members` | Team assignment (`PROJECTS.team[]`) | project_id, user_id, role_on_project | — |
| `project_vendors` | Vendor assignment (`PROJECTS.vendors[]`) | project_id, vendor_id | — |
| `tasks` (`TASKS`) | Work item | project_id, name, owner_id, due_at, status(enum `STATUS_COLS`), priority | 1—N task_dependencies |
| `task_dependencies` (**[REQUIRED]**) | Blocking relationships, not in prototype (tasks are flat) | task_id, depends_on_task_id | — |
| `flow_templates` (`FLOW_TEMPLATES`) | Reusable flow definition | name, category, steps jsonb (role, default_owner_role, sla_minutes, deps[]) | referenced by playbooks |
| `flow_instances` (`FLOWS`) | Running flow | template_id, project_id, name, created_by | 1—N flow_steps |
| `flow_steps` | Instance step | flow_instance_id, key, name, role, owner_id, sla_minutes, status(enum §6), ready_at, started_at, done_at | self-referential `flow_step_dependencies` |
| `flow_step_dependencies` | Edge list (`deps`) | step_id, depends_on_step_id, join_type(AND/OR) | — |
| `flow_step_runs` | Immutable transition log (audit) | step_id, from_status, to_status, actor_id, at | — |
| `inventory_items` (`INV`) | SKU master | sku, name, category, unit, size_ml, standard_cost, preferred_vendor_id | — |
| `inventory_locations` | City stock point | city_id, name | — |
| `inventory_balances` | **Materialized, derived-only** current qty per sku×location | sku_id, location_id, qty_on_hand, reorder_level | recomputed from `inventory_movements`, never written directly (fixes §18 flaw) |
| `inventory_movements` (`MOVES`) | Ledger — append-only | sku_id, type(purchase/receive/reserve/consume/transfer_out/transfer_in/damage/adjustment/return), from_location_id, to_location_id, qty, ref_type, ref_id, actor_id, note | source of truth for balances |
| `inventory_reservations` (`ALLOC`) | Project-level hold | sku_id, location_id, project_id, qty, status(reserved/consumed/released) | — |
| `recipes` (`RECIPES`) | Menu costing | name, glass, price | 1—N recipe_items |
| `recipe_items` | Ingredient line | recipe_id, sku_id, qty_ml | drives auto-reservation from guest count × drinks |
| `purchase_requests` (`PURCHASE_REQUESTS`) | Procurement start | project_id, item, vendor_id, amount, status(enum) | 1—N purchase_orders |
| `purchase_orders` (**[REQUIRED]**) | Formal PO | pr_id, vendor_id, total, status | 1—N goods_receipts |
| `goods_receipts` (**[REQUIRED]**) | GRN, partial-receipt aware | po_id, received_qty jsonb, received_at | triggers `inventory_movements(type=receive)` |
| `expenses` (`EXPENSES`) | Employee expense claim | user_id, project_id, category, amount, status(pending/approved/reimbursed) | — |
| `invoices` (`INVOICES`) | Client invoice | invoice_no (format `AMM/{city_code}/{fy}/{seq}`, matches prototype), client_id, project_id, city_id, issue_date, due_date, status(draft/issued/paid/partially_paid/overdue/cancelled), taxable_amount, cgst, sgst, igst, total, **[REQUIRED, missing in prototype]** | 1—N invoice_items, payments |
| `invoice_items` | Line item (`items[]`) | invoice_id, description, qty, rate, hsn_sac | — |
| `payments` | Money received | invoice_id, amount, method, received_at | — |
| `credit_notes` / `debit_notes` (**[REQUIRED]**, §22/§59) | Adjustments — never edit an issued invoice | invoice_id, amount, reason | — |
| `budgets` / `budget_lines` (**[REQUIRED]**, prototype only has `estCost` scalar) | Line-item project budget | project_id, category, planned_amount | rolls up to `est_cost` |
| `licences` (`LICENCES`) | Compliance item | project_id (nullable, e.g. `lc9` FSSAI is company-wide), type, authority, city_id, status(not_applied/applied/approved/rejected), ref_no, due_date, owner_id | escalation config §24 |
| `risks` (`RISKS`) | Risk register | project_id, title, severity(low/medium/high/critical), owner_id, impact, status(open/mitigating/monitoring/closed) | — |
| `approvals` (`APPROVALS`) | Generic approval | project_id, title, type(creative/budget/purchase/client/vendor/payment), requester_id, approver_ref, status, approval_level | §27 engine |
| `documents` (`DOCUMENTS`) | File metadata | project_id, name, type, storage_key | 1—N document_versions |
| `document_versions` (**[REQUIRED]**) | Version history | document_id, version_no, storage_key, uploaded_by | — |
| `channels` (`CHANNELS`) | Chat channel | name, kind(company/city/project/dm), city_id, project_id | auto-created on city/project creation |
| `messages` (`MSGS`) | Chat message | channel_id, author_id, body, created_at | 1—N mentions → tasks |
| `emails` (`EMAILS`) | Synced Gmail message metadata | gmail_message_id, thread_id, from, subject, linked_client_id, linked_project_id, linked_vendor_id, linked_lead_id | §16 |
| `meetings` (`MEETINGS`) | Calendar/Meet event | project_id, title, starts_at, meet_link, notes | action items → tasks |
| `runsheets` / `runsheet_items` (`RUNSHEETS`) | Event-day checklist | project_id / item text, scheduled_time, owner_id, done_at | — |
| `event_day_checkins` (`CHECKINS`) | Crew attendance on event day | project_id, user_id, checked_in_at | — |
| `event_day_incidents` (`INCIDENTS`) | Live incident log | project_id, severity, text, reported_by | can auto-spawn `risks`/`tasks` |
| `sops` (`SOPS`) / `sop_versions` | Knowledge base | title, body, department, version | — |
| `automation_rules` (`AUTOMATIONS`) | Configurable trigger→action | name, trigger_type, trigger_config jsonb, actions jsonb, is_enabled | 1—N automation_runs |
| `automation_runs` | Execution log | rule_id, triggered_by, status, error | idempotency key |
| `notifications` (`NOTIFICATIONS`) | Per-user notification | user_id, icon, text, read_at, source_type/id | — |
| `audit_logs` (`AUDIT`) | Universal audit trail | actor_id, action, entity_type, entity_id, before jsonb, after jsonb, ip, at | append-only, never deleted |

Indexes: every FK; composite `(city_id, status)` on projects/invoices/licences; `(project_id, status)` on tasks/flow_steps; `(sku_id, location_id)` on inventory_balances; GIN index on `audit_logs.after` and on FTS columns for search.

## 10. Multi-City Architecture

`CITY_SCOPE` in the prototype is a **UI filter over client-side arrays** — that pattern is explicitly banned in production. Instead: every scoped table carries `city_id`; every API request carries the caller's `user_city_access` grants; **every query is server-side filtered by an intersection of "cities the user can see" and "city_id requested,"** enforced in a single reusable query-builder middleware, not per-endpoint. "All Cities" for a Founder/Admin is a real grant (`scope=all`), not the absence of a filter. New cities (beyond Jaipur/Udaipur/Delhi/Mumbai/Bengaluru/Goa) are a data row, never a code change — the prototype already gets this right structurally (`CITIES` array + `st` GST state code), production just needs the GST state-code table to be complete for all 36 Indian states/UTs, not just the 5 seeded.

## 11. Authentication & RBAC

Roles carried forward verbatim from `ROLES`: **Founder, Admin, Project Manager, Operations, Finance, Sales, Creative, Employee, Client, Vendor.** Their prose descriptions become real permission grants:

| Role | Projects | Finance | Approve | City scope | Notes |
|---|---|---|---|---|---|
| Founder | all, full | full incl. controls | all types | all | only role with company financial controls |
| Admin | all, full | full excl. financial controls | all except budget sign-off | all | |
| Project Manager | assigned, full | view-only | project-level only | assigned cities | |
| Operations | all, ops fields | none | none | assigned cities | tasks/resources/vendors/procurement |
| Finance | view all | full | budget/payment | all | invoicing owner |
| Sales | own leads/clients | none | none | assigned cities | CRM only |
| Creative | assigned tasks | none | creative only | assigned | |
| Employee | assigned tasks/docs | none | none | assigned | |
| Client | own project (portal) | view invoices | own approvals | n/a | external, row-level scoped to their `client_id` |
| Vendor | own engagements (portal) | view own POs/payments | none | n/a | external, row-level scoped to their `vendor_id` |

Enforcement: NestJS guards resolve `(user, action, resource, resource_row)` server-side on every mutating and every financial/PII-reading endpoint — **never** trust a hidden button. Client/Vendor roles get a separate, narrower portal API surface, not the internal app with extra hiding.

## 12. Automation Engine

Generalizes the prototype's `AUTOMATIONS` array (`au1`–`au10`) into `trigger → conditions → actions → result → audit`:

- **Triggers:** event (`lead.stage_changed`, `flow_step.completed`, `invoice.overdue`), schedule/cron, threshold (`inventory_balance < reorder_level`), time-relative-to-date (`event_date - 7 days`, generalizing the compliance `T-7` and event-day `T-30/T-7/T-1` rules).
- **Conditions:** JSON-logic expression evaluated against the entity.
- **Actions:** create record, notify, escalate, webhook call — same vocabulary already used in the prototype's `actions: [...]` arrays.
- Every existing automation (`au1`–`au10`) becomes a seeded row, editable from the same Automation screen the prototype already has, with `on/off` preserved as `is_enabled`.
- **Idempotency:** every automation run keyed by `(rule_id, entity_id, trigger_hash)` — required because the prototype's own "Step done → hand off" (`au6`) and "Deal Won → Project" (`au1`) must not double-fire on webhook retries.
- **Retry:** exponential backoff, 5 attempts, then `automation_runs.status=failed` + alert to Admin.

## 13. Notification Engine

Channels: in-app (`NOTIFICATIONS`), chat DM from **Podium Bot** (`BOT`, already a prototype concept), email. WhatsApp/SMS **[FUTURE]**. User-level preferences per channel per notification type. Every automation and flow handoff writes here — this is the fan-out target, not a separate decision point.

## 14. Inventory Architecture

See `inventory_movements`/`inventory_balances`/`inventory_reservations` in §9. Movement types map 1:1 to the prototype's `MOVES.type` values already seen in seed data (`Transfer, Damage, Receive, Consume`) plus `adjustment` and `return` **[REQUIRED]**. **Balances are never written directly** — they're a materialized view recomputed (or incrementally maintained via trigger) from the movement ledger, using a row-level lock (`SELECT ... FOR UPDATE` on the balance row) per movement to make concurrent transfers/consumption safe — this directly fixes the prototype's `qty[cityIdx]-=n` in-place array mutation, which has no concurrency control at all.

## 15. Procurement Architecture

`purchase_requests` (already exists, with the exact status vocabulary seen in seed data: *Quote Comparison, RFQ Sent, Approval Pending, PO Raised, Goods Received*) → `purchase_orders` **[REQUIRED]** → `goods_receipts` **[REQUIRED, supports partial]** → vendor invoice → `payments`. Budget check against `budget_lines` before PO approval; approval routed through §27's engine using the existing `Purchase` approval type.

## 16. Finance Architecture

Per-project financial fields already tracked (`revenue, estCost, actCost, paid`) become computed views over: `budget_lines` (planned) + `purchase_orders`/`expenses` (committed/actual cost) + `payments` (collected) + `invoices` (billed). Formulas:
- Gross margin = revenue − act_cost
- Receivables = Σ invoices.total − Σ payments (per invoice)
- Payables = Σ purchase_orders.total − Σ vendor payments recorded
- Variance = est_cost − act_cost

**Crucially, the prototype's `pnl` screen is *not* a ledger** — `pnlFor()` is a seasonality formula generating plausible numbers per city (`PNL_CFG` base/cogs/seasonality). Production P&L (§23) must instead be a real aggregation over invoices/expenses/payroll — the seasonal model is useful only for forecasting/budget targets, not actuals, and this distinction must be explicit in the UI ("Actual" vs "Forecast").

## 17. Invoice Architecture

Numbering scheme preserved exactly: `AMM/{CITY_CODE}/{FY}/{SEQ}` (e.g. `AMM/UDR/26-27/0012`), sequence per city per financial year, gap-free and never reused (needed for GST compliance). New required fields not in the prototype: `hsn_sac`, `cgst/sgst/igst` (computed from client state vs. `CITIES.st` of the issuing city — intra-state = CGST+SGST, inter-state = IGST), `place_of_supply`. **Issued invoices are immutable** — corrections go through `credit_notes`/`debit_notes`, never an UPDATE. Status flow: `draft → issued → (partially_paid) → paid` / `overdue` (derived: `now() > due_date AND balance > 0`) / `cancelled` (only from `draft`).

## 18. CRM Architecture

`leads.stage` machine exactly as `CRM_STAGES`: `Lead → Qualified → Proposal → Negotiation → Won` (and `Lost`, **[REQUIRED]**, absent from the prototype's enum but necessary — a pipeline with no loss state is unusable for forecasting). `Won` fires the automation in §5A. Leads convert to a `client` (new or matched by GSTIN/phone/email dedupe **[RECOMMENDED]** — prototype has zero dedupe logic).

## 19. Project Architecture

`projects` carries `playbook_id` — created either ad hoc or, in the common case, from a `Playbook` (§8) which stamps default `project_stages`, `tasks`, and `flow_instances`. `health` (`green/amber/red`, shown today as a static seed value) becomes a computed field, recalculated on every relevant write (task overdue count, open critical risks, days-to-event, budget variance thresholds — thresholds configurable in Settings).

## 20. Event-Day Architecture

Real-time command centre over `runsheets`/`runsheet_items` (checklist with `scheduled_time`/`owner`), `event_day_checkins` (crew presence), `event_day_incidents`. Each incident write evaluates severity: `critical/high` auto-creates a `risks` row and an escalation task to the Ops Manager (generalizing the seeded incident: *"Generator backup not yet confirmed by venue," severity Medium*). All event-day screens subscribe over WebSocket to the project's channel for live updates across all crew devices simultaneously — this is the single highest-value realtime surface in the whole product.

## 21. Compliance Architecture

`licences` status machine: `not_applied → applied → approved` / `rejected`. Escalation timing generalized from the prototype's hard-coded **T-7** (`au10`) into a configurable `escalation_offset_days` per licence type per city (liquor licences, Fire NOC, police permission, music licence (PPL/IPRS), FSSAI, insurance — all already represented in seed data). A licence can be project-scoped or company-wide (`project_id NULL`, as with the seeded FSSAI licence).

## 22. People Architecture

Operationally scoped, not a full HRMS (explicitly out of scope per the brief): `users`, `departments`, city assignment (`TEAM_CITY`), `freelancers` (`FREELANCERS`), `attendance`/`leaves` (`ATTEND`, `LEAVES`) for event-day staffing decisions, skills/availability for resource assignment. Certificate/licence expiry tracked the same way as compliance items but scoped to a person (e.g., bartender certification from BCII).

## 23. Chat Architecture

Channel kinds preserved: company (`general`, `announcements`), functional (`bar-ops`), per-city (auto-created for every row in `cities`, exactly as `CHANNELS = [...CITIES.map(...)]` already does), per-project (auto-created on project creation, named from the project slug as seen with `proj-p1` → "rathi-sharma-wedding"), and DMs. `@mention` in a message can create a task (already the exact worked example in the source brief: *"@Rohit please confirm sound vendor"* → task, assignee, project link, due date). Presence (`PRESENCE`) via the same WebSocket gateway as §20/§34.

## 24. Gmail Architecture

OAuth2, scopes limited to `gmail.readonly` + `gmail.send` (never full mailbox scope). Incremental sync via Gmail `history.list` + a `watch()` push notification (Pub/Sub) rather than polling. Store only what's needed to reproduce the existing `emails` linkage — `gmail_message_id`, `thread_id`, headers, and a body snippet for the inbox view, not a full mailbox mirror (data minimization, per §16 of the source brief). Linking logic exactly matches the seeded data: match by sender domain/email to an existing `client`/`vendor`/`lead`/`project`, else route to a "needs linking" inbox tray, matching the six linked and one unlinked seed emails (`e6` has `link:null`). Token refresh via standard OAuth refresh flow; disconnect state surfaces as a banner, not a silent failure.

## 25. Calendar / Meet Architecture

Google Calendar events created from `meetings`; Google Meet link auto-attached (`MEET_CODES`); post-meeting, Meet API transcript/notes (where available) parsed into `MEET_ITEMS`-style action items, each promotable to a `task` linked to the meeting's project — this generalizes automation `au9` ("Meet ends → action items to tasks"), currently seeded `on:false`, i.e. the prototype already anticipates this exact feature as a toggle-able rule.

## 26. Document Management

`documents` + `document_versions`. Types preserved from seed data: Contract, Design, Creative, Purchase Order, Government/Permit, Guest List. Never overwrite a file in place — every upload is a new version, current pointer moves, history retained (this is currently absent — the prototype's `DOCUMENTS` array has one row per file with no version concept).

## 27. Knowledge / SOP Architecture

`sops` + `sop_versions`, owner, department, approval status, acknowledgement tracking. Post-event review can propose a new SOP or SOP revision — this is the loop that turns "an incident happened once" into "the runbook now prevents it."

## 28. Search Architecture

Postgres `tsvector` generated columns across `projects.name`, `clients.name`, `vendors.name`, `tasks.name`, `invoices.invoice_no`, `documents.name`, `messages.body`, `emails.subject` — combined ranked query behind `GET /search?q=`, filtered by the caller's RBAC + city scope before results are returned (never after). Command palette (`_buildCmdIndexV1`, `CMDK_INDEX` in the prototype) becomes a thin client wrapper over the same endpoint plus a small client-side index of navigation targets (views, settings pages) that don't need a DB round-trip.

## 29. Real-Time Architecture

WebSocket gateway (NestJS) fed by Postgres `LISTEN/NOTIFY` triggers on: `messages` (chat), `flow_steps` (handoffs, matching the prototype's `JUST_UNLOCKED` glow-on-unlock effect), `notifications`, `event_day_incidents`/`event_day_checkins`, `inventory_balances` (low-stock banners), `approvals` (live status). Everything else (dashboards, reports) is fine as polling/refetch-on-focus.

## 30. Security Architecture

- AuthN: email/password + Google SSO (reuses the Gmail OAuth relationship), session via short-lived JWT + refresh token, rotated.
- AuthZ: server-side RBAC (§11) on every endpoint, no exceptions, no "trust the frontend."
- Secrets in a vault (AWS Secrets Manager), never in env files committed to git.
- Encryption at rest (RDS default) and in transit (TLS everywhere).
- Rate limiting per user/IP on auth and search endpoints.
- Input validation via Zod schemas shared between client and server.
- Standard OWASP coverage: parameterized queries only (Prisma prevents SQL injection by default), CSRF tokens on state-changing form submissions, output-encoded rendering (React default) prevents XSS.
- Tenant isolation: every query scoped by `workspace_id` even though V1 has one tenant — cheap insurance, expensive to retrofit.
- Financial/PII fields (GSTIN, bank details if ever added, salary if People module expands) get column-level access logging.

## 31. Performance Architecture

Targets: dashboard <800ms P95, search <300ms P95, API mutations <400ms P95, invoice PDF generation <2s async (queued, not inline). Design now for 10k+ tasks, 100k+ messages, 1M+ audit rows via: pagination everywhere (cursor-based on high-volume tables), the composite indexes in §9, and partitioning `audit_logs` and `inventory_movements` by month once volume warrants it (not needed at launch).

## 32. Reliability Architecture

Idempotency keys on all financial and inventory mutation endpoints (invoice issuance, payment recording, inventory movement, PO approval). All multi-table writes wrapped in a DB transaction (e.g., "record payment" = insert payment + update invoice status, atomically). Webhook receivers (Gmail push, future payment gateway) de-duplicated by event ID. Dead-letter queue for automation/job failures after retry exhaustion, surfaced to Admin.

## 33. Observability

Structured JSON logs (request id, user id, workspace id) → CloudWatch/Loki. Errors → Sentry. Metrics (API latency, job queue depth, automation failure rate, integration health for Gmail/Calendar) → Grafana/Prometheus or a managed equivalent (Better Stack, Datadog). Alert on: automation failure spike, integration disconnect, DB replication lag, queue backlog.

## 34. Testing Strategy

Unit (business logic — flow engine transitions, invoice tax calc, inventory ledger math), integration (API + DB per module), permission tests (every role × every endpoint, generated from the RBAC matrix in §11 so it can't silently drift), financial calculation tests (GST math, P&L formulas), inventory concurrency tests (simulate parallel transfers), E2E (Playwright, covering: lead→project→invoice happy path, flow handoff chain, event-day check-in flow), load tests before each major launch phase.

## 35. DevOps / CI/CD

Trunk-based with short-lived feature branches, mandatory PR review, CI runs lint+typecheck+unit+integration on every PR, preview environment per PR (Vercel for frontend, ephemeral DB branch via Neon/Supabase branching for backend), staging mirrors production, deploy to production on merge to `main` with automated Prisma migrations gated behind a manual approval step for anything touching money/inventory tables.

## 36. Backup & Disaster Recovery

RDS automated daily snapshots + point-in-time recovery (35-day window minimum, given financial data). Object storage versioned. RPO target 15 minutes (PITR), RTO target 4 hours. Documented, tested quarterly restore drill.

## 37. Migration Strategy

Prototype seed data (`CLIENTS`, `PROJECTS`, `VENDORS`, etc.) becomes the **development/demo seed script** only — a fixture, never imported into production. Production launch starts from AMM's real client/vendor/inventory master data, entered or imported via a one-time CSV import tool built for Sprint 1 (§46), reviewed by Finance/Ops before go-live. Strict separation of `demo`, `development`, `staging`, `production` databases with no shared credentials.

## 38. Repository Structure

```
/apps
  /web            (Next.js app)
  /api            (NestJS app)
/packages
  /db             (Prisma schema, migrations)
  /shared-types   (Zod schemas, shared TS types)
  /ui             (design system components — brass/paper/Plex theme)
/workers          (BullMQ job processors: automation, notifications, email sync)
/tests
/docs             (this document, screens.md, ADRs, runbooks)
/scripts          (seed, import, backup verify)
```

## 39. Coding Standards

TypeScript strict mode everywhere. `snake_case` in DB, `camelCase` in TS, REST resources plural-noun (`/projects/:id/tasks`). No silent `catch{}`. Every mutating endpoint requires an explicit permission check and an audit-log write (enforced by a lint rule / code-review checklist item, not memory). Conventional commits. PR template requires: what changed, tables touched, permission implications, tests added.

## 40. API Architecture (representative — REST, chosen over GraphQL because the domain is entity-CRUD-plus-workflow-actions, not a deeply nested client-driven graph; revisit only if the mobile app needs aggressive query shaping)

| Resource | Endpoints |
|---|---|
| Projects | `GET/POST /projects`, `GET/PATCH /projects/:id`, `POST /projects/:id/tasks`, `GET /projects/:id/finance` |
| Flows | `POST /flow-instances` (from template), `POST /flow-steps/:id/start`, `POST /flow-steps/:id/complete`, `POST /flow-steps/:id/reassign` |
| Inventory | `POST /inventory/movements` (all mutation goes through this one endpoint, typed by `type`), `GET /inventory/balances?city_id=` |
| Invoices | `POST /invoices`, `POST /invoices/:id/issue` (locks it), `POST /invoices/:id/payments`, `POST /invoices/:id/credit-notes` |
| Approvals | `POST /approvals`, `POST /approvals/:id/decide` |
| Search | `GET /search?q=&types=&city_id=` |

Every list endpoint: cursor pagination, `filter[...]`, `sort=`. Every mutation: idempotency-key header optional but honored for financial/inventory routes. Standard error envelope `{error: {code, message, details}}`.

## 41. MVP Definition

**MVP (Phase 1–4 below):** Auth+RBAC+cities, Clients+CRM+Projects (from playbook), Tasks+Flow engine, Chat+Notifications. This alone replaces the whiteboard/WhatsApp coordination AMM runs on today and is independently valuable.
**V1:** + Vendors+Procurement, Inventory+Menu Costing, Finance+Invoices+Payments, Compliance+Event Day.
**V1.5:** + Gmail+Calendar+Meet integrations, Reports/P&L/cash flow.
**V2:** + full Automation Engine (configurable rules UI, not just seeded ones), Knowledge/SOP.
**Future:** WhatsApp/SMS notifications, client/vendor self-serve portals as full apps, dedicated search engine, HRMS depth.

## 42. Development Phases

| Phase | Scope |
|---|---|
| 0 | Repo, CI/CD, DB schema foundation, design system port |
| 1 | Auth, workspace, users, roles, city scoping |
| 2 | Clients, CRM, Projects, Playbooks |
| 3 | Tasks, Timeline, Flow engine |
| 4 | Chat, Notifications |
| 5 | Vendors, Procurement |
| 6 | Inventory, Menu Costing |
| 7 | Finance, Invoices, Payments |
| 8 | Compliance, Event Day |
| 9 | Gmail, Calendar, Meet |
| 10 | Reports, P&L, Cash Flow |
| 11 | Automation Engine (generalized) |
| 12 | Hardening, security review, scale testing |

## 43-47

See the original hand-off prompt (kept in the task history) for the sample backlog, Sprint 1 ticket table, developer setup guide, engineering hand-off checklist, and CTO risk summary — those sections are process scaffolding rather than architecture and are superseded in this repo by `docs/STATUS.md` (live status) and the actual issue history.

---

*Companion artifact recommended before coding starts: run this document plus the original HTML through a schema-diagram tool to produce a visual ERD (§9 as a picture, not just a table) — useful for onboarding and for the DBA review gate in Phase 0.*
