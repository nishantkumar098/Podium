/**
 * Podium — put imported projects (and their clients) in the right city.
 *
 * The event-calendar import matched a city only when the venue text named
 * one of the branch cities, and otherwise defaulted to the HQ city (Jaipur).
 * Almost no venue names a city ("CHATTARPUR", "B11 OPPOSITE DPS VASANT
 * VIHAR", "Hyatt Dedradun"), so 295 of 299 projects landed in Jaipur and the
 * city filter showed Delhi with 2 projects and the other branches with none.
 *
 * This reassigns each project from its venue by region, to the branch that
 * serves it:
 *   Rajasthan venues            -> Jaipur
 *   Uttarakhand venues          -> Dehradun
 *   Goa / Chennai / Mumbai      -> that branch
 *   everything else             -> Delhi (Delhi NCR localities, and
 *                                  outstation cities with no branch — the
 *                                  calendar is the Delhi team's)
 * A client then takes the city most of its projects are in.
 *
 * Only rows created by the calendar import (externalRef set) are touched.
 *
 * Usage:  pnpm projects:recity            # dry run — prints every change
 *         pnpm projects:recity --apply
 */
import { prisma } from "@podium/db";

const APPLY = process.argv.includes("--apply");
const IMPORTER = "nishant.kumar";

/** First match wins; checked against the upper-cased project name (client — venue). */
const REGIONS: Array<{ city: string; words: string[] }> = [
  { city: "Goa", words: ["GOA"] },
  { city: "Chennai", words: ["CHENNAI", "MAHABALIPURAM"] },
  { city: "Mumbai", words: ["MUMBAI"] },
  { city: "Dehradun", words: ["DEHRADUN", "DEDRADUN", "MUSSOR", "MUSSOOR", "RISHIKESH", "HARIDWAR", "RORKEE", "ROORKEE", "CORBETT"] },
  {
    city: "Jaipur",
    words: ["JAIPUR", "UDAIPUR", "UDAIVILAS", "UDAVILAS", "JODHPUR", "UMAID BHAWAN", "AJMER", "PUSHKAR", "RANTHAMBORE", "BISHANGARH", "ALILA", "SALASAR", "BARWARA", "BHANWARA", "BANWARA"],
  },
];
const DEFAULT_CITY = "Delhi";

function cityForVenue(text: string): { city: string; matched: string | null } {
  const hay = text.toUpperCase();
  for (const r of REGIONS) {
    const w = r.words.find((word) => hay.includes(word));
    if (w) return { city: r.city, matched: w };
  }
  return { city: DEFAULT_CITY, matched: null };
}

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true, name: true } });
  const importer = await prisma.user.findFirstOrThrow({ where: { username: IMPORTER }, select: { id: true } });
  const cities = await prisma.city.findMany({ where: { workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true } });
  const idOf = new Map(cities.map((c) => [c.name, c.id]));
  const nameOf = new Map(cities.map((c) => [c.id, c.name]));
  for (const c of [...REGIONS.map((r) => r.city), DEFAULT_CITY]) if (!idOf.has(c)) throw new Error(`No branch city named "${c}".`);

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, externalRef: { not: null } },
    select: { id: true, name: true, cityId: true, clientId: true },
  });

  const moves = new Map<string, string[]>(); // target cityId -> project ids
  const byCity = new Map<string, number>();
  const defaulted: string[] = [];
  const projectCity = new Map<string, string>();
  for (const p of projects) {
    const { city, matched } = cityForVenue(p.name);
    const target = idOf.get(city)!;
    projectCity.set(p.id, target);
    byCity.set(city, (byCity.get(city) ?? 0) + 1);
    if (!matched) defaulted.push(p.name);
    if (target !== p.cityId) moves.set(target, [...(moves.get(target) ?? []), p.id]);
  }

  // Each client goes where most of its (imported) projects are.
  const clientVotes = new Map<string, Map<string, number>>();
  for (const p of projects) {
    const votes = clientVotes.get(p.clientId) ?? new Map<string, number>();
    const c = projectCity.get(p.id)!;
    votes.set(c, (votes.get(c) ?? 0) + 1);
    clientVotes.set(p.clientId, votes);
  }
  const clients = await prisma.client.findMany({ where: { id: { in: [...clientVotes.keys()] } }, select: { id: true, name: true, cityId: true } });
  const clientMoves = new Map<string, string[]>();
  for (const c of clients) {
    const best = [...clientVotes.get(c.id)!.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    if (best !== c.cityId) clientMoves.set(best, [...(clientMoves.get(best) ?? []), c.id]);
  }

  const movedProjects = [...moves.values()].reduce((s, a) => s + a.length, 0);
  const movedClients = [...clientMoves.values()].reduce((s, a) => s + a.length, 0);
  console.log(`${workspace.name} — ${projects.length} imported projects`);
  console.log(`   after: ${[...byCity.entries()].map(([c, n]) => `${c} ${n}`).join(" · ")}`);
  console.log(`   projects changing city: ${movedProjects}   clients changing city: ${movedClients}`);
  for (const [target, ids] of moves) {
    console.log(`\n   -> ${nameOf.get(target)} (${ids.length})`);
    for (const id of ids) {
      const p = projects.find((x) => x.id === id)!;
      const m = cityForVenue(p.name);
      console.log(`      ${p.name}${m.matched ? `   [${m.matched}]` : ""}`);
    }
  }
  console.log(`\n   ${defaulted.length} had no region word and go to ${DEFAULT_CITY} by default (listed above without a [match]).`);
  if (!APPLY) return console.log("\nDry run — nothing was written. Re-run with --apply.");

  await prisma.$transaction(
    async (tx) => {
      for (const [cityId, ids] of moves) await tx.project.updateMany({ where: { id: { in: ids } }, data: { cityId } });
      for (const [cityId, ids] of clientMoves) await tx.client.updateMany({ where: { id: { in: ids } }, data: { cityId } });
      await tx.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: importer.id,
          action: "projects.city_reassigned_from_venue",
          entityType: "workspace",
          entityId: workspace.id,
          after: { projects: movedProjects, clients: movedClients, byCity: Object.fromEntries(byCity), defaultCity: DEFAULT_CITY, defaulted: defaulted.length },
        },
      });
    },
    { maxWait: 20_000, timeout: 120_000 },
  );
  console.log(`\nWritten: ${movedProjects} projects and ${movedClients} clients moved.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
