-- Phase B: budgets + expenses approval workflow.

-- AlterTable: budgets gain attribution. `updated_at` is NOT NULL to match the
-- Prisma @updatedAt contract, but is given a DEFAULT here so the statement is
-- safe against any pre-existing rows (all three databases hold 0 budgets
-- today, but a migration that only works on an empty table is a trap for
-- whichever environment runs it later).
ALTER TABLE "budgets" ADD COLUMN     "created_by" UUID,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: expenses gain a real approval audit trail (who decided, when,
-- why) plus an idempotency key, since an expense claim is a financial record.
ALTER TABLE "expenses" ADD COLUMN     "approved_by" UUID,
ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "decision_reason" TEXT,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "reimbursed_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_idempotency_key_key" ON "expenses"("idempotency_key");

-- CreateIndex
CREATE INDEX "expenses_project_id_status_idx" ON "expenses"("project_id", "status");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
