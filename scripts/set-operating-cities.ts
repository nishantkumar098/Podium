/**
 * Podium v2 — make AMM's operating cities exactly:
 *   Jaipur (JPR), Delhi (DEL), Mumbai (BOM), Goa (GOA), Dehradun (DDN), Chennai (MAA).
 * Udaipur (UDR) and Bengaluru (BLR) are not AMM cities and are removed.
 *
 * Every row pointing at a removed city is handled explicitly — the set of
 * referencing columns is read from the database's own foreign keys:
 *   - a nullable city on a record that keeps its own free-text location
 *     (clients, leads, vendors, freelancers) is set to NULL: the record still
 *     says "Udaipur" in its text, it just is not filed under a branch AMM
 *     does not have;
 *   - a required city (projects, invoices, licences…) moves Udaipur to Jaipur
 *     — the Rajasthan branch that serves it, same GST state (08), so no tax
 *     position changes. A required Bengaluru reference has no honest home
 *     and stops the script instead of being guessed;
 *   - per-city configuration (city access grants, invoice counters,
 *     inventory stores) for a removed city is deleted with it.
 *
 * Usage:
 *   pnpm set:cities --dry-run
 *   PODIUM_ALLOW_CITY_CHANGE=1 pnpm set:cities
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

const KEEP = [
  { code: "JPR", name: "Jaipur", state: "Rajasthan", gstStateCode: "08" },
  { code: "DEL", name: "Delhi", state: "Delhi", gstStateCode: "07" },
  { code: "BOM", name: "Mumbai", state: "Maharashtra", gstStateCode: "27" },
  { code: "GOA", name: "Goa", state: "Goa", gstStateCode: "30" },
  { code: "DDN", name: "Dehradun", state: "Uttarakhand", gstStateCode: "05" },
  { code: "MAA", name: "Chennai", state: "Tamil Nadu", gstStateCode: "33" },
];
const REMOVE = ["UDR", "BLR"];
/** Where a required reference to a removed city goes; absent = refuse. */
const MOVE_TO: Record<string, string> = { UDR: "JPR" };

/** Per-city configuration that belongs to the city itself — deleted with it. */
const OWNED_BY_CITY = new Set([
  "user_city_access.city_id",
  "invoice_counters.city_id",
  "inventory_locations.city_id",
]);

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(72)}\n${DRY_RUN ? "DRY RUN — " : ""}SET OPERATING CITIES — ${dbName}\n${"=".repeat(72)}`);

  const workspace = await prisma.workspace.findFirstOrThrow();
  const cities = await prisma.city.findMany({ where: { workspaceId: workspace.id } });
  const byCode = new Map(cities.map((c) => [c.code, c]));
  console.log(`now: ${cities.map((c) => `${c.name} (${c.code})`).join(", ")}`);

  const toAdd = KEEP.filter((k) => !byCode.has(k.code));
  const removing = REMOVE.map((c) => byCode.get(c)).filter((c): c is NonNullable<typeof c> => !!c);
  console.log(`add: ${toAdd.map((c) => c.name).join(", ") || "none"}   remove: ${removing.map((c) => c.name).join(", ") || "none"}`);

  const refs = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string }>>`
    SELECT kcu.table_name, kcu.column_name, col.is_nullable
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.columns col ON col.table_name = kcu.table_name AND col.column_name = kcu.column_name AND col.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'cities' AND ccu.column_name = 'id'
    ORDER BY kcu.table_name`;

  type Step = { city: string; ref: string; table: string; column: string; count: number; action: "null" | "move" | "delete"; to?: string };
  const plan: Step[] = [];
  for (const city of removing) {
    for (const r of refs) {
      const ref = `${r.table_name}.${r.column_name}`;
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${r.table_name}" WHERE "${r.column_name}" = $1::uuid`, city.id);
      if (Number(n) === 0) continue;
      const action = OWNED_BY_CITY.has(ref) ? "delete" : r.is_nullable === "YES" ? "null" : "move";
      if (action === "move" && !MOVE_TO[city.code]) {
        throw new Error(`${n} row(s) in ${ref} require ${city.name} and have no honest replacement — resolve these by hand first.`);
      }
      plan.push({ city: city.name, ref, table: r.table_name, column: r.column_name, count: Number(n), action, to: MOVE_TO[city.code] });
    }
  }

  console.log(`\nreferences to removed cities:`);
  for (const p of plan) {
    const what = p.action === "null" ? "set to no city" : p.action === "delete" ? "delete (city config)" : `move to ${byCode.get(p.to!)?.name}`;
    console.log(`   ${p.city.padEnd(10)} ${p.ref.padEnd(34)} ${String(p.count).padStart(6)}  → ${what}`);
  }
  if (plan.length === 0) console.log("   none");

  if (DRY_RUN) return console.log("\nDry run — nothing was changed.");
  if (process.env.PODIUM_ALLOW_CITY_CHANGE !== "1") {
    console.error("\nREFUSING: PODIUM_ALLOW_CITY_CHANGE=1 is not set.\n");
    process.exit(1);
  }

  await prisma.$transaction(
    async (tx) => {
      for (const k of toAdd) {
        await tx.city.create({ data: { workspaceId: workspace.id, ...k } });
        console.log(`   added ${k.name} (${k.code})`);
      }
      for (const p of plan) {
        const from = byCode.get(REMOVE.find((c) => byCode.get(c)?.name === p.city)!)!.id;
        const sql =
          p.action === "delete"
            ? `DELETE FROM "${p.table}" WHERE "${p.column}" = $1::uuid`
            : p.action === "null"
              ? `UPDATE "${p.table}" SET "${p.column}" = NULL WHERE "${p.column}" = $1::uuid`
              : `UPDATE "${p.table}" SET "${p.column}" = $2::uuid WHERE "${p.column}" = $1::uuid`;
        const n = p.action === "move" ? await tx.$executeRawUnsafe(sql, from, byCode.get(p.to!)!.id) : await tx.$executeRawUnsafe(sql, from);
        console.log(`   ${p.action.padEnd(6)} ${String(n).padStart(6)}  ${p.ref} (${p.city})`);
      }
      for (const c of removing) {
        await tx.city.delete({ where: { id: c.id } });
        console.log(`   removed ${c.name} (${c.code})`);
      }
    },
    { timeout: 300_000, maxWait: 20_000 },
  );

  const after = await prisma.city.findMany({ where: { workspaceId: workspace.id }, orderBy: { name: "asc" } });
  console.log(`\ncities now: ${after.map((c) => `${c.name} (${c.code})`).join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
