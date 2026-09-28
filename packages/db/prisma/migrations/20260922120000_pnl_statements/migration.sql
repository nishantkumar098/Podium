-- Hand-built P&L statements (Reports -> P&L -> Add P&L) and their lines.
CREATE TABLE "pnl_statements" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "city_id" UUID,
  "project_id" UUID,
  "period_from" DATE,
  "period_to" DATE,
  "notes" TEXT,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "pnl_statements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pnl_statements_workspace_id_deleted_at_idx" ON "pnl_statements"("workspace_id", "deleted_at");

CREATE TABLE "pnl_lines" (
  "id" UUID NOT NULL,
  "statement_id" UUID NOT NULL,
  "section" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "pnl_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pnl_lines_statement_id_idx" ON "pnl_lines"("statement_id");
ALTER TABLE "pnl_lines" ADD CONSTRAINT "pnl_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "pnl_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
