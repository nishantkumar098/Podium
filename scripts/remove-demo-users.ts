/**
 * Podium v2 — remove the 15 seed-fixture accounts once real logins exist.
 *
 * A fixture account is one with NO username: `provision-staff.ts` gives every
 * real login a username, and the seed never set one. The script refuses to
 * run unless a real Founder (with a username) exists, so it can never leave
 * the workspace without an administrator.
 *
 * Real records that point at a fixture account — the 299 calendar projects
 * list "Anant Sharma" as PM, the imported documents name him as uploader —
 * are REASSIGNED to the real Founder, not deleted. Rows that are the fixture
 * account's own identity (roles, city grants, sessions, notifications) are
 * deleted with it. The set of referencing columns is read from the database's
 * own foreign keys, so a column added later is never silently missed.
 *
 * Usage:
 *   pnpm remove:demo-users --dry-run
 *   PODIUM_ALLOW_DEMO_USER_REMOVAL=1 pnpm remove:demo-users
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

/** Belong to the account itself — removed with it rather than reassigned. */
const OWNED_BY_ACCOUNT = new Set([
  "user_roles.user_id",
  "user_city_access.user_id",
  "refresh_tokens.user_id",
  "password_invites.user_id",
  "google_accounts.user_id",
  "notifications.user_id",
  "channel_members.user_id",
  "attendance.user_id",
  "leaves.user_id",
]);

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}\n${DRY_RUN ? "DRY RUN — " : ""}REMOVE DEMO USER ACCOUNTS — ${dbName}\n${"=".repeat(72)}`);

  const founder = await prisma.user.findFirst({
    where: { username: { not: null }, deletedAt: null, isActive: true, userRoles: { some: { role: { name: "Founder" } } } },
    orderBy: { createdAt: "asc" },
  });
  if (!founder) throw new Error("no real Founder with a username exists — run provision:staff first");

  const demo = await prisma.user.findMany({ where: { username: null }, select: { id: true, name: true, email: true } });
  console.log(`\nreal Founder (reassign target): ${founder.name} (${founder.username})`);
  console.log(`demo accounts: ${demo.length}\n   ${demo.map((u) => u.email ?? u.name).join("\n   ")}`);
  if (demo.length === 0) return console.log("\nnothing to do.");
  const ids = demo.map((u) => u.id);

  const fks = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      AND ccu.table_name = 'users' AND ccu.column_name = 'id'
    ORDER BY kcu.table_name, kcu.column_name`;

  // Attribution columns (created_by / updated_by / uploaded_by) are plain UUIDs
  // by schema convention — not foreign keys — so the scan above cannot see
  // them. Without this they would be left naming a deleted account.
  const attribution = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'uuid'
      AND column_name IN ('created_by', 'updated_by', 'uploaded_by')`;
  const seen = new Set(fks.map((f) => `${f.table_name}.${f.column_name}`));
  const columns = [...fks, ...attribution.filter((a) => !seen.has(`${a.table_name}.${a.column_name}`))];

  const plan: Array<{ ref: string; table: string; column: string; count: number; action: "reassign" | "delete" }> = [];
  for (const { table_name, column_name } of columns) {
    const ref = `${table_name}.${column_name}`;
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${table_name}" WHERE "${column_name}" = ANY($1::uuid[])`,
      ids,
    );
    if (Number(n) > 0) plan.push({ ref, table: table_name, column: column_name, count: Number(n), action: OWNED_BY_ACCOUNT.has(ref) ? "delete" : "reassign" });
  }

  console.log(`\nreferences to demo accounts:`);
  for (const p of plan) console.log(`   ${p.action.padEnd(9)} ${p.ref.padEnd(40)} ${String(p.count).padStart(6)}`);

  if (DRY_RUN) return console.log("\nDry run — nothing was changed.");
  if (process.env.PODIUM_ALLOW_DEMO_USER_REMOVAL !== "1") {
    console.error("\nREFUSING: PODIUM_ALLOW_DEMO_USER_REMOVAL=1 is not set.\n");
    process.exit(1);
  }

  await prisma.$transaction(
    async (tx) => {
      for (const p of plan) {
        const sql =
          p.action === "delete"
            ? `DELETE FROM "${p.table}" WHERE "${p.column}" = ANY($1::uuid[])`
            : `UPDATE "${p.table}" SET "${p.column}" = $2::uuid WHERE "${p.column}" = ANY($1::uuid[])`;
        const n = p.action === "delete" ? await tx.$executeRawUnsafe(sql, ids) : await tx.$executeRawUnsafe(sql, ids, founder.id);
        console.log(`   ${p.action === "delete" ? "deleted " : "reassigned"} ${String(n).padStart(6)}  ${p.ref}`);
      }
      const removed = await tx.user.deleteMany({ where: { id: { in: ids } } });
      console.log(`   deleted ${String(removed.count).padStart(6)}  users`);
    },
    { timeout: 300_000 },
  );

  console.log(`\nusers remaining: ${await prisma.user.count()} (all with usernames: ${await prisma.user.count({ where: { username: null } }) === 0})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
