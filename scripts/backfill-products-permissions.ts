/**
 * Podium v2 — products permission backfill.
 *
 * The 2026-09-15 catalogue work adds a "products" RBAC resource to
 * `packages/db/prisma/seed.ts`. That only takes effect on a FRESH seed:
 * `permissions`/`role_permissions` rows are created once at seed time, never
 * upserted, and `podium_prod` can never be reseeded at all (the seed guard
 * forbids it, correctly). Without this, nobody in an existing database can
 * open the Products screen.
 *
 * Purely additive and idempotent — every insert checks first, so re-running
 * is a no-op, and nothing outside the "products" resource is read or written.
 *
 * Grants:
 *   Founder, Admin, Operations : full CRUD (Operations maintains the catalogue)
 *   Finance, Sales, Project Manager : view (pricing an invoice, quoting a deal)
 *
 * Usage: DATABASE_URL=... pnpm backfill:products-permissions
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ACTIONS = ["view", "create", "edit", "delete", "approve", "export"] as const;
const RESOURCE = "products";

const GRANTS: Record<string, string[]> = {
  Founder: ACTIONS.map((a) => `${RESOURCE}:${a}`),
  Admin: ACTIONS.map((a) => `${RESOURCE}:${a}`),
  Operations: ACTIONS.map((a) => `${RESOURCE}:${a}`),
  Finance: [`${RESOURCE}:view`],
  Sales: [`${RESOURCE}:view`],
  "Project Manager": [`${RESOURCE}:view`],
};

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow();
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\nproducts permission backfill — ${dbName} (${workspace.name})`);

  const permByKey = new Map<string, string>();
  let permsCreated = 0;
  for (const action of ACTIONS) {
    const existing = await prisma.permission.findFirst({
      where: { workspaceId: workspace.id, resource: RESOURCE, action },
    });
    if (existing) {
      permByKey.set(`${RESOURCE}:${action}`, existing.id);
      continue;
    }
    const created = await prisma.permission.create({
      data: { workspaceId: workspace.id, resource: RESOURCE, action },
    });
    permByKey.set(`${RESOURCE}:${action}`, created.id);
    permsCreated++;
  }

  let grantsCreated = 0;
  for (const [roleName, keys] of Object.entries(GRANTS)) {
    const role = await prisma.role.findFirst({ where: { workspaceId: workspace.id, name: roleName } });
    if (!role) {
      console.log(`   role "${roleName}" does not exist here — skipped`);
      continue;
    }
    for (const key of keys) {
      const permissionId = permByKey.get(key);
      if (!permissionId) continue;
      const already = await prisma.rolePermission.findFirst({ where: { roleId: role.id, permissionId } });
      if (already) continue;
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId } });
      grantsCreated++;
    }
  }

  const total = await prisma.rolePermission.count({
    where: { permission: { resource: RESOURCE, workspaceId: workspace.id } },
  });
  console.log(`   permissions created: ${permsCreated}, grants created: ${grantsCreated}`);
  console.log(`   products grants now in place: ${total}`);
  if (total === 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
