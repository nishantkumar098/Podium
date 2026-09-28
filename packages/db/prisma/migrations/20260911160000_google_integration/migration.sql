-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "is_sandbox" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "is_sandbox" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "google_email" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT NOT NULL,
    "gmail_history_id" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_user_id_key" ON "google_accounts"("user_id");

-- CreateIndex
CREATE INDEX "google_accounts_workspace_id_idx" ON "google_accounts"("workspace_id");

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

