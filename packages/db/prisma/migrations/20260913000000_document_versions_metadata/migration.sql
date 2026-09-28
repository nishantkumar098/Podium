-- Phase F: document_versions.storage_key alone can't round-trip a real file
-- on download (no original filename or content-type to hand back), and a
-- list view needs the size without touching the storage driver.
--
-- podium_dev/podium_test already carry 7 seeded document_versions rows
-- (demo metadata only -- no file was ever actually written to disk for
-- them), so this can't be a straight NOT NULL add. Backfill file_name from
-- the parent document's own name (that's genuinely what these rows are
-- named), guess mime_type from the extension, and set size_bytes to the
-- honest value for a row with no real backing file: 0, not a fabricated
-- number. podium_prod has zero document_versions rows, so its backfill
-- UPDATE is a no-op.
ALTER TABLE "document_versions" ADD COLUMN "file_name" TEXT;
ALTER TABLE "document_versions" ADD COLUMN "mime_type" TEXT;
ALTER TABLE "document_versions" ADD COLUMN "size_bytes" INTEGER;

UPDATE "document_versions" dv
SET
  file_name = d.name,
  mime_type = CASE
    WHEN d.name ILIKE '%.pdf' THEN 'application/pdf'
    WHEN d.name ILIKE '%.dwg' THEN 'application/octet-stream'
    WHEN d.name ILIKE '%.xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    WHEN d.name ILIKE '%.docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ELSE 'application/octet-stream'
  END,
  size_bytes = 0
FROM "documents" d
WHERE d.id = dv.document_id;

ALTER TABLE "document_versions" ALTER COLUMN "file_name" SET NOT NULL;
ALTER TABLE "document_versions" ALTER COLUMN "mime_type" SET NOT NULL;
ALTER TABLE "document_versions" ALTER COLUMN "size_bytes" SET NOT NULL;
