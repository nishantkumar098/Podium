/**
 * Replaces the freelance crew roster with AMM's current one.
 *
 *   dry run:  pnpm crew:import
 *   apply:    pnpm crew:import -- --apply
 *
 * The roster below is transcribed from AMM's own sheet — two tables, the
 * bartenders and the students, each with a local (Delhi) day rate and a
 * higher outstation one.
 *
 * TWO THINGS THIS SCRIPT REFUSES TO GUESS
 *
 * 1. `8750106397` appears in BOTH tables — as "Sandeep" the bartender
 *    (3000/4500) and "sandeep" the student (1500/2000). The database allows
 *    one row per phone number, so these cannot both exist. The bartender
 *    entry wins here, because it is the higher rate and the senior role, and
 *    the collision is REPORTED on every run rather than quietly resolved. If
 *    they are two different people, one of them needs a different number.
 *
 * 2. Blank rates stay blank. Several bartenders have no figure on the sheet;
 *    a rate invented for them would be quoted to a client and paid to a
 *    person. Unknown stays unknown.
 *
 * THE OLD ROWS ARE DELETED, NOT SOFT-DELETED. Nothing in the schema points at
 * a freelancer — no bookings, no assignments, no invoices — so there is no
 * history to orphan. And because `@@unique([workspaceId, phone])` counts
 * soft-deleted rows too, keeping them would permanently block those numbers
 * from ever being re-used. What was removed is written to the audit log
 * first, so the change is traceable without the rows sitting in the way.
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const db = new PrismaClient();

/** The city these rates are quoted against. "Outside Delhi" is the outstation rate. */
const HOME_CITY = "Delhi";

interface CrewRow {
  name: string;
  phone: string;
  /** In-city day rate; null where the sheet leaves it blank. */
  local: number | null;
  /** Outstation day rate; null where the sheet leaves it blank. */
  outstation: number | null;
  category: "Bartender" | "Student";
  agreementSigned?: boolean;
}

const BARTENDERS: CrewRow[] = [
  { name: "Ankit", phone: "8424951124", local: 3000, outstation: 4500, category: "Bartender" },
  { name: "Param", phone: "8383811523", local: 3000, outstation: 4500, category: "Bartender" },
  { name: "Rohit", phone: "8595757738", local: null, outstation: null, category: "Bartender" },
  { name: "Sandeep", phone: "8750106397", local: 3000, outstation: 4500, category: "Bartender" },
  { name: "Sahil", phone: "8800761944", local: null, outstation: null, category: "Bartender" },
  { name: "Sushil", phone: "9266465418", local: null, outstation: null, category: "Bartender" },
  { name: "Nikhil", phone: "8076787769", local: null, outstation: null, category: "Bartender" },
  { name: "Pradeep", phone: "9873252531", local: 2500, outstation: 4000, category: "Bartender" },
  { name: "Ravi", phone: "9810687204", local: null, outstation: null, category: "Bartender" },
  { name: "Nitin", phone: "8076555860", local: 2500, outstation: 3500, category: "Bartender" },
];

const STUDENTS: CrewRow[] = [
  { name: "Mumit", phone: "8750013161", local: 1500, outstation: 2000, category: "Student" },
  { name: "Manish", phone: "9871993082", local: 1200, outstation: 1500, category: "Student", agreementSigned: true },
  { name: "Gaurav", phone: "8882241519", local: 1200, outstation: 1500, category: "Student", agreementSigned: true },
  { name: "Vivek", phone: "7983973024", local: 1500, outstation: 2000, category: "Student" },
  { name: "Rohan", phone: "8595412216", local: 1200, outstation: 1500, category: "Student", agreementSigned: true },
  { name: "Sandeep", phone: "8750106397", local: 1500, outstation: 2000, category: "Student" },
  { name: "Tanmay", phone: "9958631566", local: 1500, outstation: 2000, category: "Student" },
  { name: "Tanish", phone: "7042531900", local: 1200, outstation: 1500, category: "Student", agreementSigned: true },
  { name: "Krishna", phone: "9411908736", local: 1500, outstation: 2000, category: "Student" },
  { name: "Gurpreet", phone: "6398802747", local: 1200, outstation: 1500, category: "Student", agreementSigned: true },
  { name: "Mohan", phone: "9315461158", local: 1500, outstation: 2000, category: "Student" },
  { name: "Shubham", phone: "7678264348", local: 1500, outstation: 2000, category: "Student" },
];

const money = (n: number | null) => (n === null ? "     —" : `₹${n.toString().padStart(5)}`);

async function main() {
  const workspace = await db.workspace.findFirst({ where: { deletedAt: null }, select: { id: true, name: true } });
  if (!workspace) throw new Error("No workspace found.");
  const city = await db.city.findFirst({ where: { workspaceId: workspace.id, name: HOME_CITY, deletedAt: null }, select: { id: true } });
  if (!city) throw new Error(`City "${HOME_CITY}" not found.`);

  console.log(`\nWorkspace: ${workspace.name}`);
  console.log(APPLY ? "Mode: APPLY — the roster will be replaced.\n" : "Mode: DRY RUN — nothing is written. Re-run with --apply.\n");

  // --- resolve the duplicate before anything else, and say so out loud
  const seen = new Map<string, CrewRow>();
  const collisions: Array<{ kept: CrewRow; dropped: CrewRow }> = [];
  for (const row of [...BARTENDERS, ...STUDENTS]) {
    const existing = seen.get(row.phone);
    if (existing) {
      collisions.push({ kept: existing, dropped: row });
      continue;
    }
    seen.set(row.phone, row);
  }
  const roster = [...seen.values()];

  if (collisions.length) {
    console.log("Same number in both tables — one row each, the first listing wins:");
    for (const c of collisions) {
      console.log(`  ! ${c.kept.phone}  keeping ${c.kept.name} (${c.kept.category}, ${money(c.kept.local)}/${money(c.kept.outstation)})`);
      console.log(`  !              dropping ${c.dropped.name} (${c.dropped.category}, ${money(c.dropped.local)}/${money(c.dropped.outstation)})`);
    }
    console.log();
  }

  // --- what is being removed
  const existing = await db.freelancer.findMany({ select: { id: true, name: true, phone: true, category: true } });
  console.log(`Removing ${existing.length} existing crew records.`);
  const keptNumbers = new Set(roster.map((r) => r.phone));
  const alsoInNew = existing.filter((e) => keptNumbers.has((e.phone ?? "").replace(/\D/g, "").slice(-10)));
  if (alsoInNew.length) {
    console.log(`  (${alsoInNew.length} of them are in the new roster too and will be re-created from it: ${alsoInNew.map((e) => e.name).join(", ")})`);
  }

  // --- what is going in
  console.log(`\nNew roster — ${roster.length} people (${roster.filter((r) => r.category === "Bartender").length} bartenders, ${roster.filter((r) => r.category === "Student").length} students)\n`);
  console.log(`  ${"NAME".padEnd(12)} ${"NUMBER".padEnd(12)} ${"LOCAL".padEnd(7)} ${"OUTSTN".padEnd(7)} KIND       AGREEMENT`);
  for (const r of roster) {
    console.log(
      `  ${r.name.padEnd(12)} ${r.phone.padEnd(12)} ${money(r.local)} ${money(r.outstation)} ${r.category.padEnd(10)} ${r.agreementSigned ? "signed" : "—"}`,
    );
  }
  const noRate = roster.filter((r) => r.local === null);
  if (noRate.length) console.log(`\n  ${noRate.length} with no rate on the sheet, left blank: ${noRate.map((r) => r.name).join(", ")}`);

  if (!APPLY) {
    console.log("\nCheck the numbers above against your sheet, then re-run with --apply.\n");
    return;
  }

  await db.auditLog.create({
    data: {
      workspaceId: workspace.id,
      actorId: null,
      action: "freelancers.roster_replaced",
      entityType: "freelancer",
      entityId: workspace.id,
      after: { removed: existing.length, added: roster.length, removedNames: existing.map((e) => `${e.name} ${e.phone ?? ""}`.trim()) },
    },
  });

  await db.freelancer.deleteMany({});
  for (const r of roster) {
    await db.freelancer.create({
      data: {
        workspaceId: workspace.id,
        cityId: city.id,
        name: r.name,
        phone: r.phone,
        phoneRaw: r.phone,
        category: r.category,
        source: "AMM crew roster sheet",
        externalRef: `crew-roster:${r.phone}`,
        dayRate: r.local,
        dayRateOutstation: r.outstation,
        agreementSigned: r.agreementSigned ?? false,
        isAvailable: true,
      },
    });
  }
  console.log(`\nDone. ${existing.length} removed, ${roster.length} added, all in ${HOME_CITY}.\n`);
}

main()
  .catch((e) => {
    console.error("\nimport-crew-roster failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
