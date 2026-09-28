-- CreateEnum
CREATE TYPE "InvoiceDocType" AS ENUM ('TAX_INVOICE', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "InvoiceScope" AS ENUM ('FIXED', 'VARIABLE');

-- CreateEnum
CREATE TYPE "ProductPricingMode" AS ENUM ('PER_QUANTITY', 'PER_GUEST', 'FIXED');

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "detail" TEXT,
ADD COLUMN     "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "scope" "InvoiceScope" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "brand_id" UUID,
ADD COLUMN     "doc_type" "InvoiceDocType" NOT NULL DEFAULT 'TAX_INVOICE',
ADD COLUMN     "payment_terms" TEXT,
ADD COLUMN     "quotation_ref" TEXT,
ADD COLUMN     "round_off" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "service_location" TEXT;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tagline" TEXT,
    "website" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "external_ref" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "service_line" TEXT,
    "category" TEXT,
    "short_desc" TEXT,
    "long_desc" TEXT,
    "unit" TEXT,
    "price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pricing_mode" "ProductPricingMode" NOT NULL DEFAULT 'PER_QUANTITY',
    "gst_rate" DECIMAL(5,4),
    "hsn_sac" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "stock_qty" DECIMAL(14,2),
    "vendor_name" TEXT,
    "source_flag" TEXT,
    "source_file" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_workspace_id_code_key" ON "brands"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "products_workspace_id_brand_id_category_idx" ON "products"("workspace_id", "brand_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "products_workspace_id_external_ref_key" ON "products"("workspace_id", "external_ref");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_scope_sort_order_idx" ON "invoice_items"("invoice_id", "scope", "sort_order");

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
