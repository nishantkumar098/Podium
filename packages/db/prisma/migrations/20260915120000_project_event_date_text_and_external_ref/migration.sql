-- Preserve AMM's raw calendar date string alongside the parsed timestamp.
-- The calendar records free text ("26-27th Sept", "29th Nov - Sangeet 2nd Dec
-- - Haldi"), and event_date can only ever hold the first day of a multi-day
-- booking; keeping the original makes every parsed date auditable.
ALTER TABLE "projects" ADD COLUMN "event_date_text" TEXT;

-- Stable key for rows imported from the event calendar, so re-importing
-- updates in place rather than duplicating. Nullable: projects created in the
-- app have no external source.
ALTER TABLE "projects" ADD COLUMN "external_ref" TEXT;

CREATE UNIQUE INDEX "projects_workspace_id_external_ref_key" ON "projects"("workspace_id", "external_ref");
