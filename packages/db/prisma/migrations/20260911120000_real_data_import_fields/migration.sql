-- CreateEnum
CREATE TYPE "ClientSegment" AS ENUM ('EVENT_CLIENT', 'RETAIL_CUSTOMER');

-- CreateEnum
CREATE TYPE "LeadKind" AS ENUM ('PIPELINE', 'COLD_PROSPECT');

-- DropForeignKey
ALTER TABLE "clients" DROP CONSTRAINT "clients_city_id_fkey";

-- DropForeignKey
ALTER TABLE "freelancers" DROP CONSTRAINT "freelancers_city_id_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_city_id_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_owner_id_fkey";

-- DropForeignKey
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_city_id_fkey";

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "address" TEXT,
ADD COLUMN     "client_segment" "ClientSegment" NOT NULL DEFAULT 'EVENT_CLIENT',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "external_ref" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phone_raw" TEXT,
ADD COLUMN     "source" TEXT,
ALTER COLUMN "city_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "freelancers" ADD COLUMN     "category" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phone_raw" TEXT,
ADD COLUMN     "source" TEXT,
ALTER COLUMN "city_id" DROP NOT NULL,
ALTER COLUMN "cert_expires_at" DROP NOT NULL,
ALTER COLUMN "day_rate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "address" TEXT,
ADD COLUMN     "company" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "designation" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "event_date" TIMESTAMP(3),
ADD COLUMN     "event_type" TEXT,
ADD COLUMN     "intake_detail" JSONB,
ADD COLUMN     "kind" "LeadKind" NOT NULL DEFAULT 'PIPELINE',
ADD COLUMN     "location_text" TEXT,
ADD COLUMN     "pax" INTEGER,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phone_raw" TEXT,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "source_file" TEXT,
ADD COLUMN     "source_sheet" TEXT,
ADD COLUMN     "website" TEXT,
ALTER COLUMN "value" DROP NOT NULL,
ALTER COLUMN "owner_id" DROP NOT NULL,
ALTER COLUMN "city_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "address" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phone_raw" TEXT,
ADD COLUMN     "source" TEXT,
ALTER COLUMN "category" DROP NOT NULL,
ALTER COLUMN "city_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "clients_workspace_id_client_segment_idx" ON "clients"("workspace_id", "client_segment");

-- CreateIndex
CREATE UNIQUE INDEX "clients_workspace_id_phone_key" ON "clients"("workspace_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "freelancers_workspace_id_phone_key" ON "freelancers"("workspace_id", "phone");

-- CreateIndex
CREATE INDEX "leads_workspace_id_kind_idx" ON "leads"("workspace_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "leads_workspace_id_phone_key" ON "leads"("workspace_id", "phone");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freelancers" ADD CONSTRAINT "freelancers_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

