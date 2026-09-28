-- BUG-007: one lead -> at most one live conversion, enforced by the database.
--
-- leads.converted_project_id could never enforce this: a second conversion
-- UPDATEs that column on the same lead row, so there is no second row for a
-- constraint to reject. Moving the link to the project makes a second
-- conversion a second INSERT, which an index can refuse.

ALTER TABLE "projects" ADD COLUMN "converted_from_lead_id" UUID;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_converted_from_lead_id_fkey"
  FOREIGN KEY ("converted_from_lead_id") REFERENCES "leads"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill from the existing one-way link so already-converted leads are
-- protected too, not just new ones.
UPDATE "projects" p
   SET "converted_from_lead_id" = l."id"
  FROM "leads" l
 WHERE l."converted_project_id" = p."id";

-- The invariant. PARTIAL on two counts, both deliberate:
--   * IS NOT NULL   — every project that was not converted from a lead leaves
--                     the column NULL, and they must not collide with one
--                     another. (Postgres already treats NULLs as distinct;
--                     this is stated so the intent survives a future edit.)
--   * deleted_at IS NULL — a conversion whose project was soft-deleted must
--                     not lock the lead out of ever being converted again.
--                     The invariant is "at most one VALID ACTIVE conversion".
CREATE UNIQUE INDEX "projects_one_live_conversion_per_lead"
    ON "projects" ("converted_from_lead_id")
 WHERE "converted_from_lead_id" IS NOT NULL AND "deleted_at" IS NULL;
