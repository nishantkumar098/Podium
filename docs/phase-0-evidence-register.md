# Phase 0 Evidence Register

The canonical record of what Phase 0 found, what was done about it, and what
is still open. **Entries are never rewritten out of existence.** A finding that
turns out to be misfiled is superseded and linked, not deleted — how something
was first classified is part of the evidence.

Namespaces: **DQ** data quality · **SEC** security · **OPS** operational
reliability · **BUG** defect · **AMM** a decision only AMM can make.

Last updated 2026-09-16.

---

## Security

### SEC-001 — Password hashes served over the API · **CLOSED**

`include: { pm: true }` returns every scalar on the related row, and `User`
carries `passwordHash`. `GET /api/projects` handed each project manager's
bcrypt hash to any caller with `projects:view`. Confirmed read-only against
production by replaying the query: `passwordHash present: true`, not null.

Fixed with a shared `SAFE_USER_SELECT` allow-list rather than four hand-written
`select` blocks — hand-written ones are how it happened. The e2e test asserts
on the HTTP response, not on the constant, so a future `include: { user: true }`
written in ignorance still fails. Commit `0d075e0`.

### SEC-002 — The sensitive-column guard missed a real HR sheet, twice · **CLOSED**

`Master_Sheet.xlsx`'s "Employee Deatils" sheet puts its column titles in a
**data** row, so `sheet_to_json` invents `__EMPTY_n` keys and a header-only
check sailed past columns literally headed SALARY DETAILS, Bank Details and
Adhar Card. The values were briefly visible in probe output before the miss was
caught by manual inspection.

Fixed in two parts, because there were two distinct failures:

1. `blockedColumnsIn` / `blockedKeysIn` locate the heading row wherever it is.
2. The government-id pattern insisted on the canonical "AADHAAR"; AMM spells it
   "Adhar Card". Widened to A(a)dh(a)(a)r in all its forms.

**The near-miss is the more useful record.** Scanning cell values to find a
heading would have blocked the name column of `INFLUENCER LIST` — a real person
is surnamed **Adhaar** — and the website column of `ANM BOOK BAR &REST`, whose
listed venue is **passcodeonly.com**. Two legitimate datasets silently
destroyed to protect nothing. The scan now only considers a row whose every
filled cell is short and none of which is shaped like data. Commit `96635de`.

### SEC-003 — Field-level authorization for HR data · **CLOSED (architecture), OPEN (AMM decision)**

The guard above is an *ingestion* safeguard. It says nothing about a field once
it is inside Podium, and would not have prevented SEC-001.

`apps/api/src/common/data-classification.ts` tiers every `User` column and all
16 columns of AMM's employee sheet — classified **before** import, not
restricted after. RESTRICTED (compensation) and HIGHLY_RESTRICTED (bank,
government identifiers, identity-document links) are not imported and have no
columns: the strongest field-level control available is not holding the field,
and a test asserts against the live database that no such column exists.

`people:view_restricted` and `people:view_identity` exist and are held by
**nobody**, including the founder. CREDENTIAL-tier fields have no permission at
all. Enforcement is an allow-list walked against live API responses; proven by
reverting SEC-001's fix and watching it fail. Commit `dfadd3e`.

Open: **AMM-DECISION-HR-SCOPE** below.

### SEC-004 — Identity-document links are identity data · **CLOSED**

The "Adhar Card" column holds Google Drive URLs to Aadhaar scans rather than
numbers. A link is not a weaker form of an identifier: anyone who can read it
can open the document. Classified HIGHLY_RESTRICTED, identically to the number,
and asserted as such.

---

## Operational reliability

### OPS-001 — The background worker is started by nothing · **OPEN — not activated**

*Supersedes DQ-008 (see Superseded entries).*

`workers/` schedules three jobs and no deployment path starts it: absent from
`scripts/dev-up.sh`, `.github/workflows/`, `docker-compose.yml` and every other
script. `pnpm --filter @podium/workers start` exists; nothing invokes it.

Consequences: the flow-SLA sweep (every minute), the invoice overdue sweep
(daily) and the automation tick (every ten minutes) have never run in any
environment. Two fully wired, enabled, end-to-end-tested automation rules
cannot fire.

**Deliberately not fixed by starting it.** Waking a dormant scheduler activates
every inert behaviour at once, in one tick, against real rows. The inventory of
what it owns, with per-job idempotency, retry, tests, risk and activation
readiness, is `docs/worker-responsibility-inventory-2026-09-16.md`. Steps 1–5 of
the activation sequence are complete; 6–9 are not started.

### OPS-002 — No queue retention and no failure alerting · **OPEN**

`upsertJobScheduler` is called without `removeOnComplete`, `removeOnFail` or
`attempts`. Completed job records accumulate in Redis forever — roughly 525,000
a year from the one-minute sweep alone — and a failed job is logged to stdout
and nowhere else. Neither is a correctness problem; both are things to fix
before activation rather than discover after.

### OPS-003 — The codebase had no business timezone · **CLOSED**

Every server and every stored timestamp is UTC, and nothing anywhere named the
timezone AMM works in, so every calendar boundary silently meant midnight in
London. `apps/api/src/common/business-time.ts` now names `Asia/Kolkata`.
Found via BUG-010 below, which is what it cost.

---

## Defects

### BUG-004 — see SEC-001 · **CLOSED**

### BUG-005 — SLA escalation deleted the work it was chasing · **CLOSED**

Escalation wrote `ESCALATED` into the step's **status**, overwriting READY or
ACTIVE. Since `startStep` requires READY and `completeStep` requires READY or
ACTIVE, an escalated step could never be started or finished again. A mechanism
whose entire job is "this is late, please do it" removed the work item from the
workflow, permanently, every time it fired.

Escalation is now a flag — `escalatedAt`, `escalationLevel`,
`escalationRiskId` — and the status is left as its humans left it. Migration
`20260916160000_flow_step_escalation_flag` restores each previously escalated
step's real status from its own `flow_step_runs` history. Commit `7c6baf0`.

Found while tracing, and fixed in the same pass: the sweep escalated steps in
cancelled flows, archived flows, archived projects and cancelled projects — an
archived project went on nagging its former PM every minute.

### BUG-006 — Parallel AND-join stalled the flow forever · **CLOSED**

Two completions feeding one joined step raced. At READ COMMITTED each
transaction read the other's step as still open, so neither unlocked the join
and the flow stalled permanently with nothing recording why. The mirror
interleaving was no better: both unlock, two READY transitions, two
notifications.

Reproduced: with the lock removed the joined step is still LOCKED after both
predecessors complete. Fixed with a deterministic `FOR UPDATE` over the
instance's steps plus a LOCKED-guarded unlock. Commit `7c6baf0`.

### BUG-007 — One lead could convert into many projects · **CLOSED**

`POST /leads/:id/convert` read the lead and then created a client, a project, a
channel and a notification with nothing asking whether it had already done
exactly that. Reproduced: five simultaneous requests produced five projects,
five channels and five clients, with the lead keeping only the last writer's
ids.

Three layers: a pre-flight check placed ahead of field validation (a retry
resends its original body, and validating first would 400 a conversion that had
succeeded); `SELECT ... FOR UPDATE` on the lead row; and partial unique index
`projects_one_live_conversion_per_lead`. The link had to move onto the project —
a second conversion *updates* `leads.converted_project_id` on one row, so no
constraint can see it. Commits `5962b4b`, `45df4ae`.

Scope, proven by test: the limit is on the **conversion**, not the client. A
converted client holds as many further projects as AMM sells it. Restoring an
archived conversion whose lead has been re-converted returns a 409 naming the
project in the way — never the P2002.

### BUG-010 — Invoices were marked overdue a day early, every time · **CLOSED**

Due dates arrive as `2026-09-16` and `z.coerce.date()` stores them at midnight
**UTC**, which is 05:30 in Jaipur. The sweep compared `dueDate < now`, so from
05:30 IST on the morning an invoice fell due it was OVERDUE and the PM was told
a client with a full working day left was late.

Found while auditing what OPS-001's dormant process owns — it had never run, so
nobody had seen it. Fixed by comparing against the close of the business day.
Commit `7c6baf0`.

---

## Data quality

### DQ-001 — No verified opening inventory · **OPEN**

125 movements and 120 balances are prototype fixtures. Quarantine work is
PHASE 0 §1, not yet done. Until it is, the low-stock automation must stay
unexercised: its first tick would raise purchase requests from fictional stock.
This is the stated blocker on OPS-001's activation.

### DQ-002 — Estimate template is derived, not approved · **OPEN**

Reconstructed from a supplied PDF. Must carry DRAFT / DERIVED / NOT APPROVED
and must not be customer-downloadable until AMM confirms the wording. The
declaration text in `invoice-pdf.service.ts` is mine and is flagged in place.

### DQ-003 — Chennai is not an operating city · **OPEN**

Present in source data; not in AMM's operating-city master. To be staged as
`UNCONFIRMED_OPERATING_CITY` with its source city preserved — not mapped to
another city, not discarded.

### DQ-004 — Vendor data needs a staging pipeline · **OPEN**

RAW → STAGING → NORMALIZATION → DUPLICATE DETECTION → EXISTING ENTITY MATCHING
→ RECONCILIATION → EXCEPTIONS → APPROVED IMPORT → PRODUCTION, with provenance
preserved at every step. `Vendor Database` is primary; city drafts and the
Rajasthan Google listings are separate datasets, not to be merged blindly.

### DQ-005 — 2026 policy manual is knowledge, not behaviour · **OPEN**

Feeds People/HR, Knowledge/SOPs, policy search and document storage. Prose is
not to be converted into hard-coded behaviour, and HR policy stays separate
from event-licence compliance.

### DQ-006 — No automation has ever executed · **OPEN, tracked under OPS-001**

Zero runs in `podium_prod` and `podium_dev`. Cause is OPS-001 for two rules and
"the trigger has not occurred" for the other two.

### DQ-007 — HR master carries data Podium must not hold · **CLOSED as a finding, see SEC-003**

31 employees, 16 columns, of which four are compensation or identity. Recorded
in `docs/quarantine/hr-master-*.md`: one sheet refused whole, eight columns
refused. The manifest names columns only — never a value, not even a hash —
which is why it is safe to commit.

---

## Superseded

### DQ-008 — Background worker not started · **SUPERSEDED by OPS-001**

Filed 2026-09-16 as a Data Quality entry while classifying the automation
rules. Wrong namespace: nothing about the data is wrong, a process is not
running. Kept here so the original classification stays on the record.
**Do not use DQ-008; use OPS-001.**

---

## Decisions only AMM can make

| Id | Question | Default in force |
| --- | --- | --- |
| **AMM-DECISION-HR-SCOPE** | Should Podium hold compensation or identity-document data at all? | **No.** Not imported, no columns, permissions granted to nobody. Reversing this is a deliberate act, not a config change. |
| **AMM-DECISION-SLA-HOURS** | Does the SLA clock run overnight? A step ready at 18:45 IST with a 90-minute SLA currently breaches at 20:15, with nobody at a desk. | Clock runs continuously — the existing behaviour, and the one that errs toward escalating too eagerly rather than too late. |
| **AMM-DECISION-SLA-LADDER** | Are 1× / 2× / 4× SLA and owner → PM → Founder/Admin the right rungs and recipients? | Mine, not AMM's. There is no reporting hierarchy in the schema to derive a real one from. |
| **AMM-DECISION-WON-FLOW** | Should a one-click "mark Won" auto-build the project, or is manual conversion the only path? | Manual only. The automation is correct and tested but unreachable — no UI calls `mark-won`. |
| **AMM-DECISION-ESTIMATE-TEXT** | Is the estimate's declaration wording correct? | Mine, flagged in place, not customer-facing. |
| **AMM-DECISION-HR-DOB** | Keep dates of birth? The only use anyone has named is a birthday list. | Not stored. |
