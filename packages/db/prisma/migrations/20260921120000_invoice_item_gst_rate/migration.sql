-- Per-line GST rate. Existing lines were all billed at 18%, so the default
-- keeps every issued invoice's stored figures exactly as they are.
ALTER TABLE "invoice_items" ADD COLUMN "gst_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.18;
