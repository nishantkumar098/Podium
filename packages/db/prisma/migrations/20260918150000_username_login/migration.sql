-- Username sign-in: staff log in by name, not e-mail.
ALTER TABLE "users" ADD COLUMN "username" TEXT;
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
-- Self-service password change no longer exists, so a forced-change flag
-- could never be satisfied; clear it rather than strand an account.
UPDATE "users" SET "must_change_password" = false WHERE "must_change_password" = true;
