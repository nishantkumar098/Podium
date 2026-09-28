/**
 * Podium v2 — the two restricted-HR permissions, created and granted to NOBODY.
 *
 * PHASE 0 §B/§C. Podium holds no salary, bank or identity data, and this
 * script does not change that. What it creates is the authorization surface
 * those tiers would need, so that:
 *
 *   * the tiering in `apps/api/src/common/data-classification.ts` names
 *     permissions that actually exist rather than aspirational strings;
 *   * a future feature that touches compensation or identity documents has a
 *     permission to require, instead of inventing one under time pressure;
 *   * granting that access is a deliberate, auditable act by a named person,
 *     not something an existing role turns out to already cover.
 *
 * DELIBERATELY UNGRANTED. Every other backfill in this directory hands its
 * new permissions to Founder, Admin and Operations. This one grants to
 * nobody, including the founder. If AMM decides Podium must carry identity
 * documents, the grant is made then, explicitly, with a reason — and this
 * script will report the change.
 *
 * Purely additive and idempotent.
 *
 * Usage: DATABASE_URL=... pnpm backfill:restricted-hr-permissions
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  {
    resource: "people",
    action: "view_restricted",
    what: "compensation (salary, CTC, payroll-adjacent figures)",
  },
  {
    resource: "people",
    action: "view_identity",
    what: "bank details, government identifiers, and links to identity documents",
  },
];

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow();
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\nrestricted-HR permission backfill — ${dbName} (${workspace.name})`);

  for (const { resource, action, what } of NEW_PERMISSIONS) {
    const existing = await prisma.permission.findFirst({ where: { workspaceId: workspace.id, resource, action } });
    if (existing) {
      console.log(`   ${resource}:${action} already exists`);
    } else {
      await prisma.permission.create({ data: { workspaceId: workspace.id, resource, action } });
      console.log(`   created ${resource}:${action} — ${what}`);
    }
  }

  // The check that matters. If either of these is ever held by a role, it was
  // granted by a person, and this script says so loudly rather than quietly
  // treating it as normal.
  const holders = await prisma.rolePermission.findMany({
    where: {
      permission: {
        workspaceId: workspace.id,
        resource: "people",
        action: { in: NEW_PERMISSIONS.map((p) => p.action) },
      },
    },
    include: { role: true, permission: true },
  });

  if (holders.length === 0) {
    console.log("\n   held by: nobody, as intended — Podium stores no data in these tiers.");
  } else {
    console.log("\n   *** GRANTED — these are held by a role: ***");
    for (const h of holders) console.log(`       ${h.role.name} holds ${h.permission.resource}:${h.permission.action}`);
    console.log("   If that was not a deliberate decision, revoke it.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
