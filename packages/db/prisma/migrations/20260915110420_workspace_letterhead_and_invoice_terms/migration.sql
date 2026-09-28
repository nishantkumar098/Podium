-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "address" TEXT,
ADD COLUMN     "bank_account_name" TEXT,
ADD COLUMN     "bank_account_no" TEXT,
ADD COLUMN     "bank_ifsc" TEXT,
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "invoice_declaration" TEXT,
ADD COLUMN     "invoice_terms" TEXT[],
ADD COLUMN     "website" TEXT;
