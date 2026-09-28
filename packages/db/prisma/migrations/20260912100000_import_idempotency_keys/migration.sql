-- AlterTable
ALTER TABLE "freelancers" ADD COLUMN     "external_ref" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "external_ref" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "external_ref" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "clients_workspace_id_external_ref_key" ON "clients"("workspace_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "freelancers_workspace_id_external_ref_key" ON "freelancers"("workspace_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "leads_workspace_id_external_ref_key" ON "leads"("workspace_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_workspace_id_external_ref_key" ON "vendors"("workspace_id", "external_ref");

