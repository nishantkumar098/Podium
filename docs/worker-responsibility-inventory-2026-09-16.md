# The dormant worker — what it owns, and what happens when it wakes

**PHASE 0 §F/§H.** The `workers/` process is not started by anything: not
`scripts/dev-up.sh`, not `.github/workflows/`, not `docker-compose.yml`, not
any other script in the repository. `pnpm --filter @podium/workers start`
exists and nothing invokes it.

**It has not been started, and must not be started on the strength of having
been found.** Starting a dormant scheduler activates every inert behaviour it
owns at once, against three years of accumulated production rows, in a single
tick. This page is the inventory that has to come first.

Tracked as **OPS-001** (see `docs/phase-0-evidence-register.md`), which
supersedes the original DQ-008 filing — the finding is an operational
reliability defect, not a data-quality one.

---

## Every scheduled responsibility

Three, and only three. There are no `@Cron` decorators, no `setInterval`, and
no `ScheduleModule` left anywhere in `apps/api/src` — all three schedules were
deliberately moved into Redis in Phase H so that N API instances produce one
tick rather than N.

| Job | Schedule | Handler | Business effect | Read/write scope |
| --- | --- | --- | --- | --- |
| `invoice.overdue-sweep` | `0 2 * * *` (02:00 **UTC** = 07:30 IST) | `InvoicesService.sweepOverdue` | ISSUED / PARTIALLY_PAID invoices past due → OVERDUE; audit row; notification to the project PM | Reads all invoices workspace-wide; writes `invoices.status`, `audit_logs`, `notifications`. Not city-scoped, not permission-gated — runs as the system |
| `flow.sla-sweep` | `* * * * *` (every minute) | `FlowSlaService.checkSlaBreaches` | READY/ACTIVE steps past their SLA → escalation flag, risk raised, recipients notified, project channel message, audit row | Reads all live flow steps; writes `flow_steps.escalation_*`, `risks`, `notifications`, `messages`, `flow_step_runs`, `audit_logs` |
| `automation.tick` | `*/10 * * * *` | `AutomationScheduler.sweep` | Raises `licence.due_date_minus_days:*` and `inventory_balance.available_lt_reorder_level`; retries failed automation runs | Reads licences and inventory balances per workspace; writes whatever the matched handlers write — `risks`, `notifications`, `purchase_requests`, `automation_runs` |

| Job | Idempotency mechanism | Retry behaviour | Tests | Production risk if started today | Activation readiness |
| --- | --- | --- | --- | --- | --- |
| `invoice.overdue-sweep` | Re-reads under the transaction and guards the `updateMany` on status **and** due date, so a payment landing mid-sweep is a no-op rather than a regression from PAID | None at the queue level (BullMQ `attempts` is unset → 1). A failure waits for tomorrow's tick | `invoices-management.e2e-spec.ts` — transition, audit, notification, PAID protection, second-sweep idempotence, and the two IST boundary cases | **Low, now.** Zero invoices exist in `podium_prod`. The day-early defect that made this dangerous is fixed | **READY** |
| `flow.sla-sweep` | `escalationLevel` claimed by a guarded `UPDATE ... WHERE escalation_level < :level` inside the same transaction as every effect, so ten ticks, three concurrent sweeps and a post-crash retry all produce one of everything | None at the queue level. A step whose escalation throws is retried on the next tick — the level claim rolls back with the transaction | `flow-sla.e2e-spec.ts` (4) and `flow-sla-escalation.e2e-spec.ts` (17): status preservation, deadline boundary, completed-before/after, cancelled and archived parents, ladder, recipients, inactive owner, one-risk-sharpened, ten ticks, concurrent sweeps, retry | **Low, now.** Zero flow steps exist in `podium_prod`. Before BUG-005 was fixed this job would have bricked every late step it touched | **READY** |
| `automation.tick` | Per-run key `(ruleId, triggeredBy, triggerHash)` with a unique index, claimed **before** the action runs | `AutomationService.retryFailed` re-runs FAILED runs on a 1s/5s/30s backoff, four attempts maximum, then stops for a human | `automation.e2e-spec.ts` — both sweep-driven rules end to end, plus idempotency and a disabled rule | **Low, now.** Licences: none in `podium_prod`. Inventory: the only balances are quarantined fixtures (PHASE 0 §1), so a low-stock alert would be raised against stock nobody has verified | **BLOCKED on §1** — quarantine the fixture inventory first, or the first tick raises purchase requests from fictional stock levels |

---

## Not job-specific, and both real

**No retention on the BullMQ queue.** `upsertJobScheduler` is called without
`removeOnComplete` or `removeOnFail`, so every completed job record is kept in
Redis forever. At one tick a minute that is ~525,000 job records a year from
`flow.sla-sweep` alone. Not a correctness problem, and not something to
discover in production.

**No retry configuration and no alerting.** `attempts` is unset, so a job that
throws is failed once and logged to stdout by `worker.on("failed")`. Nothing
pages anyone, and nothing surfaces a failed sweep in Podium itself. For the
two sweeps this is tolerable — they are idempotent and the next tick retries
naturally — but a silent failure of the invoice sweep would simply mean nobody
is told about overdue money, and no one would know.

**The schedule is in UTC.** `0 2 * * *` is 07:30 in Jaipur. That happens to be
a reasonable time to run it, but it is a coincidence rather than a decision,
and it should be stated as one.

---

## The order activation has to follow

1. ~~Inventory the responsibilities~~ — this page. **COMPLETE**
2. ~~Investigate defects~~ — **COMPLETE**: BUG-005, BUG-006 and the invoice
   timezone defect were all found in this pass.
3. ~~Repair~~ — **COMPLETE**, commit `7c6baf0`.
4. ~~Regression tests~~ — **COMPLETE**: 21 flow-SLA tests, 3 new invoice
   timezone tests, all proven against the broken implementations.
5. ~~Idempotency / retry tests~~ — **COMPLETE**: ten consecutive ticks,
   three concurrent sweeps, retry-after-failure.
6. **Controlled non-production execution** — NOT STARTED. Run the worker
   against `podium_dev` with real-shaped data and watch a full cycle.
7. **Observe** — NOT STARTED.
8. **Production-readiness decision** — NOT STARTED.
9. **Production activation** — NOT STARTED, and blocked on PHASE 0 §1.

Steps 6–9 are deliberately not taken in this pass. Everything before them is.
