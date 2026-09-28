/**
 * Podium v2 — Phase G backfill: au11 "Chat @mention -> notification" rule.
 *
 * Same situation as scripts/backfill-phase-e-permissions.ts: adding a row
 * to packages/db/prisma/seed.ts's AUTOMATIONS array only affects a *fresh*
 * seed run. podium_dev/podium_test are already seeded, and podium_prod can
 * never be reseeded at all (the seed guard forbids it). This script is the
 * safe alternative: additive, idempotent (skips if a rule with this name
 * already exists in the workspace), and touches nothing else.
 *
 * Usage: DATABASE_URL=... pnpm exec ts-node --transpile-only -P scripts/tsconfig.json scripts/backfill-au11-chat-mention-rule.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const RULE_NAME = "Chat @mention → notification";
const TRIGGER = "chat.mentioned";
const ACTIONS = ["Notify the mentioned person"];

async function main() {
  const workspace = await prisma.workspace.findFirstOrThrow();
  console.log(`Workspace: ${workspace.id} (${workspace.name})`);

  const existing = await prisma.automationRule.findFirst({ where: { workspaceId: workspace.id, name: RULE_NAME } });
  if (existing) {
    console.log(`Rule "${RULE_NAME}" already exists (id ${existing.id}) — nothing to do.`);
    return;
  }

  const created = await prisma.automationRule.create({
    data: {
      workspaceId: workspace.id,
      name: RULE_NAME,
      triggerType: "event",
      triggerConfig: { trigger: TRIGGER } as Prisma.InputJsonValue,
      actions: ACTIONS as unknown as Prisma.InputJsonValue,
      isEnabled: true,
    },
  });
  console.log(`Created rule "${RULE_NAME}" (id ${created.id}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
