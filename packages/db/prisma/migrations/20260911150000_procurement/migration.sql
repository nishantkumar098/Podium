-- AlterEnum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'CLOSED';

-- DropForeignKey
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_project_id_fkey";

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "purchase_request_id" UUID,
ALTER COLUMN "project_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "location_id" UUID NOT NULL,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "purchase_requests" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "requested_by" UUID;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "procurement_approval_threshold" DECIMAL(14,2) NOT NULL DEFAULT 50000;

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty_ordered" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_po_id_sku_id_key" ON "purchase_order_items"("po_id", "sku_id");

-- CreateIndex
CREATE INDEX "approvals_purchase_request_id_idx" ON "approvals"("purchase_request_id");

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_purchase_request_id_fkey" FOREIGN KEY ("purchase_request_id") REFERENCES "purchase_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

