-- BUG-005: escalation becomes a flag on the step instead of the step's status.
--
-- Setting status = 'ESCALATED' overwrote READY/ACTIVE, and since startStep
-- requires READY and completeStep requires READY or ACTIVE, an escalated step
-- could never be started or completed again. The SLA sweep — a notification
-- mechanism — was permanently removing work items from the workflow.

ALTER TABLE "flow_steps"
  ADD COLUMN "escalated_at"      TIMESTAMP(3),
  ADD COLUMN "escalation_level"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "escalation_risk_id" UUID;

-- Restore the workflow status of every step the old code escalated.
--
-- The pre-escalation status is recoverable because every transition wrote a
-- flow_step_runs row: the escalation's own `from_status` is exactly what the
-- step was before it was overwritten. Where several exist, the most recent
-- escalation is the one that did the damage.
WITH last_escalation AS (
  SELECT DISTINCT ON (r.step_id)
         r.step_id, r.from_status, r.at
    FROM "flow_step_runs" r
   WHERE r.to_status = 'ESCALATED'
   ORDER BY r.step_id, r.at DESC
)
UPDATE "flow_steps" s
   SET "status"           = e.from_status,
       "escalated_at"     = e.at,
       "escalation_level" = 1
  FROM last_escalation e
 WHERE s.id = e.step_id
   AND s."status" = 'ESCALATED';

-- A step left as ESCALATED here has no run row explaining how it got there
-- (seed fixtures written directly at that status). It cannot be restored to a
-- status it never had, so it is moved to READY — the state that lets a human
-- pick it up — and flagged, rather than left in a status nothing can act on.
UPDATE "flow_steps"
   SET "status"           = 'READY',
       "escalated_at"     = COALESCE("ready_at", "created_at"),
       "escalation_level" = 1
 WHERE "status" = 'ESCALATED';

-- The sweep reads (status, escalation_level) on every tick.
CREATE INDEX "flow_steps_sla_sweep_idx"
    ON "flow_steps" ("status", "escalation_level")
 WHERE "deleted_at" IS NULL AND "ready_at" IS NOT NULL;
