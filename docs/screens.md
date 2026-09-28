# Podium v2 — Screen Reverse-Engineering (all 33 screens)

Extends blueprint §2.2 (which sampled 13 of 33) to the full navigation map from
the prototype's `data-view` router (`docs/prototype/podium-v2-amm-brands.html`).
Same columns throughout. "Backend dependency" names the API/service this screen
needs once it's a real page in `apps/web`, not a prototype array.

Status column: ✅ = has a working API module in this repo as of this commit,
🚧 = schema exists, API partial/stubbed, ⬜ = schema only / not yet started.
Check `docs/STATUS.md` for the authoritative up-to-date state — this table is
the functional spec, not a progress tracker.

| # | Screen (`data-view`) | Purpose | Reads | Writes | Key actions | Backend dependency | Status |
|---|---|---|---|---|---|---|---|
| 1 | `dashboard` | Founder/PM control tower — KPIs, project health, approvals, risks, upcoming events, activity feed | `PROJECTS`, `INVOICES`, `RISKS`, `APPROVALS`, `LEADS`, `ACTIVITY` | none (read-only) | drill into module, "+ New Project" | `GET /reports/dashboard` aggregation endpoint, cached per city scope | ✅ |
| 2 | `mywork` | Personal queue: flow steps ready/active for `CURRENT_USER`, tasks owned, pending approvals, notifications | `FLOWS` (my steps), `TASKS`, `APPROVALS`, `NOTIFICATIONS` | complete/snooze/nudge | mark done, start step, approve | Per-user query joining `flow_steps`, `tasks`, `approvals`, `notifications`; needs priority ranking | 🚧 |
| 3 | `flows` | Flow template library + running instances + step handoff canvas, bottleneck analytics | `FLOW_TEMPLATES`, `FLOWS` (`flow_instances`/`flow_steps`) | `instantiateFlow`, `startStep`, `completeStep`, `nudgeStep`, `doReassign` | launch flow from template, start/complete/nudge/reassign a step | Flow engine service (state machine, §6); WS push on unlock | ✅ |
| 4 | `projects` | Project list with health/status/progress | `PROJECTS`, `CLIENTS`, `VENDORS`, `TEAM` | edit project fields, create from playbook | open project, filter by city | `GET/POST /projects`, city-scoped | ✅ |
| 5 | `tasks` | Kanban across `STATUS_COLS` (Backlog→Planned→In Progress→Client Review→Approved→Completed) | `TASKS` | drag between columns, reassign, change priority | move status, assign owner | `PATCH /tasks/:id`, optimistic concurrency (version/updated_at check) | ✅ |
| 6 | `timeline` | Master event timeline — all active projects staged T-180…T+7 relative to event date | `PROJECTS` | none | open project from timeline node | derived from `projects.event_date`, no new table | ⬜ |
| 7 | `chat` | Channels: company/city/project/DM, presence, @mention→task | `CHANNELS`, `MSGS`, `PRESENCE`, `READ` | post message, mark read, `@mention` → task | send message, create channel, mention-to-task | Chat service (§23), WS gateway for presence + live messages | 🚧 |
| 8 | `mail` | Gmail-style inbox linked to CRM objects | `MAIL_FOLDERS`, `EMAILS` | star/read/reply, link to lead/client/vendor/project | reply in Gmail, link email, convert to lead/task | Gmail integration (§24) — OAuth2 `gmail.readonly`+`gmail.send` only | ⬜ (stub) |
| 9 | `calendar` | Month grid of event dates + meetings | `PROJECTS`, `MEETINGS` | none | navigate months, open project/meeting | derived view over `projects.event_date` + `meetings.starts_at` | ⬜ |
| 10 | `meetings` | Meeting list with Google Meet links, action items → tasks | `MEETINGS`, `MEET_CODES`, `MEET_ITEMS` | schedule meeting, add notes, promote action item to task | join Meet, add to calendar, promote item | Calendar/Meet integration (§25) — stub without real OAuth creds | ⬜ (stub) |
| 11 | `eventday` | Live run-of-show, crew check-in, incident log, crew broadcast | `RUNSHEETS`, `RUNSTATE`, `CHECKINS`, `INCIDENTS` | tick cue, check in crew, log incident, broadcast | check off runsheet item, check in, log incident (auto-raises risk if High/Critical), broadcast to project channel | Realtime WS channel per project (§20/§29); incident→risk automation | ⬜ |
| 12 | `resources` | Team capacity table + physical/equipment resource board | `TEAM`, `PROJECTS`, `TASKS` (derived load %) | none in prototype (equipment assignment is static seed) | — | Resource allocation view; equipment as its own table **[RECOMMENDED, not in blueprint §9 — flag before building if scope grows beyond a read-only view]** | ⬜ |
| 13 | `risks` | Risk register across projects, feeds project health scoring | `RISKS` | create/update risk, change status | open project at risks tab | `risks` CRUD, feeds `projects.health` computation (§19) | 🚧 (schema only) |
| 14 | `inventory` | Per-city stock grid vs reorder point, transfers, receive, consume, adjust, low-stock alerts | `INV`, `ALLOC`, `MOVES` | `MOVES.unshift` + direct `qty[cityIdx]` mutation (**non-atomic — the exact flaw §14 fixes**) | transfer, receive, consume, adjust stock | Inventory ledger (`inventory_movements`→derived `inventory_balances`, row-locked, §14) | 🚧 |
| 15 | `recipes` | Cocktail recipe costing — ingredient ml × unit cost + garnish vs menu price | `RECIPES`, `INV` (cost lookup) | create/edit recipe | recompute margin, drives auto-reservation from guest count × drinks | `recipes`/`recipe_items` CRUD; reservation trigger not yet in prototype **[REQUIRED]** | 🚧 (schema only) |
| 16 | `procurement` | PR → RFQ → PO → Goods Received pipeline | `PURCHASE_REQUESTS` | advance status | raise PR, advance stage | `purchase_requests`→`purchase_orders`→`goods_receipts` (§15); GRN triggers `inventory_movements(type=receive)` | ⬜ (schema only) |
| 17 | `vendors` | Vendor master with rating, outstanding payables, status | `VENDORS` | none in prototype list view (detail not shown) | open vendor detail | `vendors`/`vendor_contacts` CRUD, payables view over `purchase_orders`+payments | ✅ (schema; basic CRUD) |
| 18 | `crm` | Sales pipeline kanban across `CRM_STAGES` | `LEADS` | drag between stages | move stage, "Won" fires Deal→Project automation (`au1`) | `leads` CRUD + stage-change event triggering automation engine (§5A/§18) | 🚧 |
| 19 | `clients` | Client master list with LTV, since-date, active project count | `CLIENTS` | create client | open client detail | `clients`/`client_contacts` CRUD, city-scoped | ✅ |
| 20 | `invoices` | City/FY-numbered invoices with GST, ageing, payment recording | `INVOICES`, `CLIENTS`, `PROJECTS` | mark sent, record payment (no GST split, no immutability in prototype — the exact gap §17 fixes) | issue, record payment, print/PDF | Invoice engine: numbering (`AMM/{city}/{fy}/{seq}`), CGST/SGST/IGST split, immutability + credit notes (§17) | ✅ (numbering + GST engine; PDF pending) |
| 21 | `finance` | Consolidated revenue/cost/margin + project-wise P&L table | `PROJECTS` (revenue/estCost/actCost/paid) | none | open project at budget tab, export | Real aggregation over `budgets`/`purchase_orders`/`expenses`/`payments`/`invoices` (§16) — **not** the seasonality model | 🚧 |
| 22 | `pnl` | City/company P&L — **fully synthetic seasonality formula (`pnlFor()`)**, not real accounting | `PNL_CFG`, `pnlFor()` | none | switch city/period, YTD/Q1/Q2/monthly views | Real GL aggregation for "Actual" (§16); the seasonal model may ship only as an explicitly labeled "Forecast" — **never blended with actuals, per blueprint §16 and prompt §7** | ⬜ |
| 23 | `expenses` | Employee expense claims, Finance approves/reimburses | `EXPENSES` | submit claim, approve/decline/mark reimbursed | submit, approve, reimburse | `expenses` CRUD with approval state machine, city/role-scoped visibility (own claims vs. Finance sees all) | 🚧 (schema only) |
| 24 | `people` | Attendance snapshot, leave requests, freelance bartender pool | `TEAM`, `ATTEND`, `LEAVES`, `FREELANCERS` | approve/decline leave, book freelancer | approve leave (Founder/Head of Ops only), book freelancer for event | `attendance`/`leaves`/`freelancers` tables (§22 — deliberately not a full HRMS) | ⬜ (schema only) |
| 25 | `compliance` | Licence tracker with T-7 escalation, red banner for at-risk permits | `LICENCES` | advance status (not applied→applied→approved) | mark applied/approved, escalate | `licences` state machine + configurable `escalation_offset_days` per type/city (§21) | 🚧 (schema only) |
| 26 | `approvals` | Cross-project approval queue (creative/budget/purchase/client/vendor/payment) | `APPROVALS` | approve item | approve (single-click in prototype — production needs decision reason + approval level) | `approvals` CRUD + decision endpoint routed by type/level (§27 references this as "the approvals engine") | 🚧 (schema only) |
| 27 | `documents` | File list with type tags, linked to project | `DOCUMENTS` | upload (no versioning in prototype — the exact gap §26 fixes) | upload, open project at documents tab | `documents`/`document_versions`, S3-backed storage interface (§26) | ⬜ (schema only) |
| 28 | `reports` | Revenue-by-type chart, project distribution by city, margin/task-completion/vendor-rating/conversion stat tiles | `PROJECTS`, `VENDORS`, `LEADS` (all derived) | none | — | Reporting aggregation endpoints, same underlying data as `finance`/`pnl`/`crm` (§28 search infra also feeds command palette here) | ⬜ |
| 29 | `knowledge` | SOP list + static playbook type gallery | `SOPS` | create SOP (button present, not wired) | open SOP | `sops`/`sop_versions` (§27); playbook gallery maps to `playbooks` table (§8/§19) | ⬜ (schema only) |
| 30 | `automation` | Rule list with on/off toggle, trigger→actions chip flow | `AUTOMATIONS` | toggle `on` | enable/disable rule | Automation engine (§12): `automation_rules`/`automation_runs`, generalized trigger/condition/action model, seeded from `au1`–`au10` | 🚧 (schema + seed only) |
| 31 | `audit` | Session-only change log (person, action, timestamp), CSV export | `AUDIT` (in-memory, resets on refresh — the exact flaw production fixes) | none (read-only) | export CSV | `audit_logs` — append-only, written by the shared interceptor on every mutation, never by hand (§7/§30) | ✅ (interceptor writes; export pending) |
| 32 | `settings` | Roles & permissions table (free-text `perms`, zero enforcement), integrations panel | `ROLES` | none (read-only in prototype) | view role descriptions | Real `roles`/`permissions`/`user_city_access` tables + guard system (§11); integration health surfaced here per prompt §14 | 🚧 |
| 33 | `whatsnew` | Static "what's new in v2" changelog pointing at flows/chat/mail/meet/inventory/invoices | `WHATS_NEW` (hardcoded copy) | none | deep-link into referenced screen | No backend — static content page or a `release_notes` table if it needs to be editable without a deploy **[FUTURE, out of blueprint scope]** | ⬜ |

## Notes on screens not in blueprint §9's schema as separate tables

- **`timeline`** and **`calendar`** are pure derived views over `projects.event_date`
  and `meetings.starts_at` — no new table needed.
- **`resources`**'s equipment board (Mobile Bar Unit, LED Wall, Generator, etc.) is
  static seed data in the prototype with no CRUD. Blueprint §9 doesn't define an
  `equipment` table. Treated as **out of scope** for the V1 schema; flagged rather
  than silently added, per prompt §17's "anything that contradicts an explicit rule"
  clause — this isn't a contradiction, just an omission, so building it is a judgment
  call for a later phase, not now.
- **`whatsnew`** is static marketing copy for the prototype's audience (its own
  product team); it carries no data model and is deliberately left out of the API
  surface.
- **`reports`** and **`pnl`**/**`finance`** all read the same underlying financial
  facts through different aggregations — there is one source of truth
  (`invoices`+`payments`+`expenses`+`purchase_orders`+`budgets`), not three.
