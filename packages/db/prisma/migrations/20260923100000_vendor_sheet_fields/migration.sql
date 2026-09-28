-- Vendor details from AMM's vendor sheet: brand, website, tax and bank
-- details, payment terms and the balance/payment dates as recorded there.
ALTER TABLE "vendors" ADD COLUMN "brand" TEXT;
ALTER TABLE "vendors" ADD COLUMN "website" TEXT;
ALTER TABLE "vendors" ADD COLUMN "pan" TEXT;
ALTER TABLE "vendors" ADD COLUMN "bank_name" TEXT;
ALTER TABLE "vendors" ADD COLUMN "bank_account_no" TEXT;
ALTER TABLE "vendors" ADD COLUMN "bank_ifsc" TEXT;
ALTER TABLE "vendors" ADD COLUMN "upi_id" TEXT;
ALTER TABLE "vendors" ADD COLUMN "payment_terms" TEXT;
ALTER TABLE "vendors" ADD COLUMN "credit_days" INTEGER;
ALTER TABLE "vendors" ADD COLUMN "opening_balance" DECIMAL(14,2);
ALTER TABLE "vendors" ADD COLUMN "last_payment_at" DATE;
ALTER TABLE "vendors" ADD COLUMN "next_payment_due_at" DATE;
ALTER TABLE "vendors" ADD COLUMN "remarks" TEXT;
