/**
 * Podium v2 — Phase E permission backfill (playbooks, recipes).
 *
 * Phase E adds two new RBAC resources ("playbooks", "recipes") to
 * `packages/db/prisma/seed.ts`'s RESOURCES/ROLE_GRANTS. That change only
 * takes effect on a *fresh* seed run (podium_dev/podium_test get it the next
 * time someone reseeds); it does nothing for a database that was already
 * seeded, since `permissions`/`role_permissions` rows are `create`d once at
 * seed time, not upserted. `podium_prod` in particular can never be reseeded
 * (the seed guard forbids it outright, correctly), so its 15 real users would
 * otherwise never get the new grants at all.
 *
 * This script is the safe alternative: purely additive, idempotent (checks
 * existence before every insert, so re-running it is a no-op), and touches
 * only the two new resources — nothing else in `permissions`/
 * `role_permissions` is read or written. Run it once against each of
 * podium_dev / podium_test / podium_prod after this migration lands.
 *
 * Grants applied (see docs/STATUS.md Phase E report for the reasoning,
 * flagged there as an OPEN DECISION needing Anant's confirmation):
 *   - Founder, Admin: full CRUD on both playbooks and recipes.
 *   - Project Manager: playbooks:view only (picks a playbook at deal-won
 *     conversion time; playbook authoring stays with Founder/Admin).
 *   - Operations: full CRUD on recipes (menu costing is bar-ops' job).
 *
 * Usage: DATABASE_URL=... pnpm exec ts-node --transpile-only -P scripts/tsconfig.json scripts/backfill-phase-e-permissions.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ACTIONS = ["view", "create", "edit", "delete", "approve", "export"] as const;
const NEW_RESOURCES = ["playbooks", "recipes"] as const;

const GRANTS: Record<string, string[]> = {
  Founder: NEW_RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`)),
  Admin: NEW_RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`)),
  "Project Manager": ["playbooks:view"],
  Operations: ACTIONS.map((a) => `recipes:${a}`),
};

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow();
  console.log(`Workspace: ${workspace.id} (${workspace.name})`);

  const permByKey = new Map<string, string>();
  for (const resource of NEW_RESOURCES) {
    for (const action of ACTIONS) {
      const key = `${resource}:${action}`;
      const existing = await prisma.permission.findUnique({
        where: { workspaceId_resource_action: { workspaceId: workspace.id, resource, action } },
      });
      if (existing) {
        permByKey.set(key, existing.id);
        continue;
      }
      const created = await prisma.permission.create({ data: { workspaceId: workspace.id, resource, action } });
      permByKey.set(key, created.id);
      console.log(`  created permission ${key}`);
    }
  }

  let grantedCount = 0;
  for (const [roleName, keys] of Object.entries(GRANTS)) {
    const role = await prisma.role.findFirst({ where: { workspaceId: workspace.id, name: roleName } });
    if (!role) {
      console.log(`  SKIP: role "${roleName}" not found in this workspace`);
      continue;
    }
    for (const key of new Set(keys)) {
      const permissionId = permByKey.get(key);
      if (!permissionId) continue;
      const existing = await prisma.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
      });
      if (existing) continue;
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId } });
      grantedCount++;
      console.log(`  granted ${key} to ${roleName}`);
    }
  }

  console.log(`Done. ${grantedCount} new role_permissions row(s) created.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
