/**
 * Podium v2 — remove the demo seed fixture, keep everything real.
 *
 * This is NOT `wipe-business-data.ts`. That script clears every business
 * table wholesale, for a rebuild-from-the-workbooks reset. This one is
 * surgical: it deletes only the rows `packages/db/prisma/seed.ts` invented
 * (Cognizant, Zomato, "Rathi–Sharma Sangeet", the Absolut/Bacardi SKUs) and
 * leaves every imported record untouched, because by the time this runs the
 * same tables also hold AMM's real data.
 *
 * HOW A FIXTURE ROW IS IDENTIFIED — evidence, not name matching:
 *   - clients / vendors / leads / projects / freelancers carry a deterministic
 *     `externalRef` when they come from a source workbook (enforced by a real
 *     `@@unique([workspaceId, externalRef])`). The seed sets none. So
 *     `externalRef IS NULL` is exactly the fixture set, and stays correct
 *     however many times an importer is re-run.
 *   - everything downstream (tasks, invoices, documents, approvals…) is
 *     reached through the seed projects/clients it hangs off, never deleted
 *     table-wide — the documents imported by `import-uploaded-documents.ts`
 *     are workspace-level (`project_id IS NULL`) and survive this.
 *   - the chat channels, inventory ledger + catalogue, recipes, SOPs,
 *     attendance and leaves exist ONLY as fixture rows (no importer writes
 *     them), so those are cleared in full.
 *
 * DELIBERATELY KEPT — the system, not the demo:
 *   workspace, cities, GST codes, roles, permissions, role_permissions,
 *   automation_rules, flow_templates, brands, and USER ACCOUNTS.
 *
 *   The 15 accounts are fixture people, but they are also the only way to
 *   sign in, and none of the supplied workbooks carries an employee e-mail
 *   address — "AMM EMPLOYEE DATA" is a crew roster (NAME / MOBILE NO /
 *   CATEGORY) that imports as Freelancers. Deleting the accounts without real
 *   ones to replace them leaves a system nobody can log into, so the delete
 *   waits until the create is actually possible.
 *
 * Usage:
 *   pnpm remove:seed-data --dry-run
 *   PODIUM_ALLOW_SEED_REMOVAL=1 pnpm remove:seed-data
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unknown)";
  console.log(`\n${"=".repeat(74)}`);
  console.log(`${DRY_RUN ? "DRY RUN — " : ""}REMOVE SEED FIXTURE DATA — ${dbName}`);
  console.log(`${"=".repeat(74)}`);

  const workspace = await prisma.workspace.findFirst();
  if (!workspace) throw new Error("no workspace in this database");

  const fixture = { workspaceId: workspace.id, externalRef: null };
  const projectIds = (await prisma.project.findMany({ where: fixture, select: { id: true } })).map((r) => r.id);
  const clientIds = (await prisma.client.findMany({ where: fixture, select: { id: true } })).map((r) => r.id);
  const vendorIds = (await prisma.vendor.findMany({ where: fixture, select: { id: true } })).map((r) => r.id);
  const leadIds = (await prisma.lead.findMany({ where: fixture, select: { id: true } })).map((r) => r.id);
  const freelancerIds = (await prisma.freelancer.findMany({ where: fixture, select: { id: true } })).map((r) => r.id);

  const inProjects = { projectId: { in: projectIds } };
  const invoiceIds = (
    await prisma.invoice.findMany({
      where: { OR: [{ projectId: { in: projectIds } }, { clientId: { in: clientIds } }] },
      select: { id: true },
    })
  ).map((r) => r.id);
  const documentIds = (await prisma.document.findMany({ where: inProjects, select: { id: true } })).map((r) => r.id);
  const channelIds = (await prisma.channel.findMany({ select: { id: true } })).map((r) => r.id);
  const flowInstanceIds = (await prisma.flowInstance.findMany({ select: { id: true } })).map((r) => r.id);
  const flowStepIds = (await prisma.flowStep.findMany({ select: { id: true } })).map((r) => r.id);
  const runsheetIds = (await prisma.runsheet.findMany({ select: { id: true } })).map((r) => r.id);
  const recipeIds = (await prisma.recipe.findMany({ select: { id: true } })).map((r) => r.id);
  const sopIds = (await prisma.sop.findMany({ select: { id: true } })).map((r) => r.id);

  console.log(`\nfixture anchors: ${projectIds.length} projects, ${clientIds.length} clients, ${vendorIds.length} vendors, ${leadIds.length} leads, ${freelancerIds.length} freelancers`);

  /** Child-before-parent. Each entry is [label, count fn, delete fn]. */
  const steps: Array<[string, () => Promise<number>, () => Promise<{ count: number }>]> = [
    ["event_day_checkins", () => prisma.eventDayCheckin.count({ where: inProjects }), () => prisma.eventDayCheckin.deleteMany({ where: inProjects })],
    ["event_day_incidents", () => prisma.eventDayIncident.count({ where: inProjects }), () => prisma.eventDayIncident.deleteMany({ where: inProjects })],
    ["runsheet_items", () => prisma.runsheetItem.count({ where: { runsheetId: { in: runsheetIds } } }), () => prisma.runsheetItem.deleteMany({ where: { runsheetId: { in: runsheetIds } } })],
    ["runsheets", () => prisma.runsheet.count(), () => prisma.runsheet.deleteMany({})],
    ["meeting_action_items", () => prisma.meetingActionItem.count(), () => prisma.meetingActionItem.deleteMany({})],
    ["meetings", () => prisma.meeting.count(), () => prisma.meeting.deleteMany({})],
    ["risks", () => prisma.risk.count({ where: inProjects }), () => prisma.risk.deleteMany({ where: inProjects })],

    ["goods_receipts", () => prisma.goodsReceipt.count(), () => prisma.goodsReceipt.deleteMany({})],
    ["purchase_order_items", () => prisma.purchaseOrderItem.count(), () => prisma.purchaseOrderItem.deleteMany({})],
    ["purchase_orders", () => prisma.purchaseOrder.count(), () => prisma.purchaseOrder.deleteMany({})],
    ["purchase_requests", () => prisma.purchaseRequest.count(), () => prisma.purchaseRequest.deleteMany({})],

    ["invoice_items", () => prisma.invoiceItem.count({ where: { invoiceId: { in: invoiceIds } } }), () => prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } })],
    ["credit_notes", () => prisma.creditNote.count({ where: { invoiceId: { in: invoiceIds } } }), () => prisma.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } })],
    ["debit_notes", () => prisma.debitNote.count({ where: { invoiceId: { in: invoiceIds } } }), () => prisma.debitNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } })],
    ["payments", () => prisma.payment.count({ where: { invoiceId: { in: invoiceIds } } }), () => prisma.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } })],
    ["invoices", async () => invoiceIds.length, () => prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } })],
    ["budget_lines", () => prisma.budgetLine.count(), () => prisma.budgetLine.deleteMany({})],
    ["budgets", () => prisma.budget.count(), () => prisma.budget.deleteMany({})],
    ["expenses", () => prisma.expense.count({ where: inProjects }), () => prisma.expense.deleteMany({ where: inProjects })],

    ["document_versions", () => prisma.documentVersion.count({ where: { documentId: { in: documentIds } } }), () => prisma.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } })],
    ["documents (project-scoped fixtures only)", async () => documentIds.length, () => prisma.document.deleteMany({ where: { id: { in: documentIds } } })],
    ["approvals", () => prisma.approval.count(), () => prisma.approval.deleteMany({})],

    ["task_dependencies", () => prisma.taskDependency.count(), () => prisma.taskDependency.deleteMany({})],
    ["tasks", () => prisma.task.count({ where: inProjects }), () => prisma.task.deleteMany({ where: inProjects })],
    ["flow_step_runs", () => prisma.flowStepRun.count({ where: { stepId: { in: flowStepIds } } }), () => prisma.flowStepRun.deleteMany({ where: { stepId: { in: flowStepIds } } })],
    ["flow_step_dependencies", () => prisma.flowStepDependency.count(), () => prisma.flowStepDependency.deleteMany({})],
    ["flow_steps", () => prisma.flowStep.count(), () => prisma.flowStep.deleteMany({})],
    ["flow_instances", async () => flowInstanceIds.length, () => prisma.flowInstance.deleteMany({})],

    ["channel_members", () => prisma.channelMember.count(), () => prisma.channelMember.deleteMany({})],
    ["messages", () => prisma.message.count(), () => prisma.message.deleteMany({})],
    ["channels", async () => channelIds.length, () => prisma.channel.deleteMany({})],
    ["notifications", () => prisma.notification.count(), () => prisma.notification.deleteMany({})],
    ["emails", () => prisma.email.count(), () => prisma.email.deleteMany({})],

    ["inventory_reservations", () => prisma.inventoryReservation.count(), () => prisma.inventoryReservation.deleteMany({})],
    ["inventory_movements", () => prisma.inventoryMovement.count(), () => prisma.inventoryMovement.deleteMany({})],
    ["inventory_balances", () => prisma.inventoryBalance.count(), () => prisma.inventoryBalance.deleteMany({})],
    ["recipe_items", () => prisma.recipeItem.count({ where: { recipeId: { in: recipeIds } } }), () => prisma.recipeItem.deleteMany({ where: { recipeId: { in: recipeIds } } })],
    ["recipes", async () => recipeIds.length, () => prisma.recipe.deleteMany({})],
    ["inventory_items (fabricated SKU catalogue)", () => prisma.inventoryItem.count(), () => prisma.inventoryItem.deleteMany({})],
    ["inventory_locations", () => prisma.inventoryLocation.count(), () => prisma.inventoryLocation.deleteMany({})],

    ["sop_versions", () => prisma.sopVersion.count({ where: { sopId: { in: sopIds } } }), () => prisma.sopVersion.deleteMany({ where: { sopId: { in: sopIds } } })],
    ["sops (placeholder bodies)", async () => sopIds.length, () => prisma.sop.deleteMany({})],

    // Every licence row is fixture — no importer writes one, and the 9th is
    // workspace-level ("FSSAI licence — central kitchen", project_id NULL),
    // so scoping to the seed projects would have stranded it.
    ["licences", () => prisma.licence.count(), () => prisma.licence.deleteMany({})],
    ["project_vendors", () => prisma.projectVendor.count({ where: inProjects }), () => prisma.projectVendor.deleteMany({ where: inProjects })],
    ["project_members", () => prisma.projectMember.count({ where: inProjects }), () => prisma.projectMember.deleteMany({ where: inProjects })],
    ["projects", async () => projectIds.length, () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],

    ["attendance", () => prisma.attendance.count(), () => prisma.attendance.deleteMany({})],
    ["leaves", () => prisma.leave.count(), () => prisma.leave.deleteMany({})],

    ["client_contacts", () => prisma.clientContact.count({ where: { clientId: { in: clientIds } } }), () => prisma.clientContact.deleteMany({ where: { clientId: { in: clientIds } } })],
    ["clients", async () => clientIds.length, () => prisma.client.deleteMany({ where: { id: { in: clientIds } } })],
    ["leads", async () => leadIds.length, () => prisma.lead.deleteMany({ where: { id: { in: leadIds } } })],
    ["vendor_contacts", () => prisma.vendorContact.count({ where: { vendorId: { in: vendorIds } } }), () => prisma.vendorContact.deleteMany({ where: { vendorId: { in: vendorIds } } })],
    ["vendors", async () => vendorIds.length, () => prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })],
    ["freelancers", async () => freelancerIds.length, () => prisma.freelancer.deleteMany({ where: { id: { in: freelancerIds } } })],
  ];

  console.log(`\nWILL DELETE:`);
  let total = 0;
  for (const [label, count] of steps) {
    const n = await count();
    total += n;
    if (n > 0) console.log(`   ${label.padEnd(44)} ${n.toLocaleString().padStart(7)}`);
  }
  console.log(`   ${"—".repeat(44)} ${total.toLocaleString().padStart(7)}`);

  if (DRY_RUN) {
    console.log(`\nDry run — nothing was deleted.`);
    return;
  }
  if (process.env.PODIUM_ALLOW_SEED_REMOVAL !== "1") {
    console.error(`\nREFUSING: PODIUM_ALLOW_SEED_REMOVAL=1 is not set.\n`);
    process.exit(1);
  }

  // One transaction: a half-removed fixture with dangling references is worse
  // than either end state.
  await prisma.$transaction(
    async (tx) => {
      void tx;
      for (const [label, , del] of steps) {
        const { count } = await del();
        if (count > 0) console.log(`   deleted ${String(count).padStart(7)}  ${label}`);
      }
    },
    { timeout: 600_000 },
  );

  // The seeded counters counted seeded invoices. Left alone they would make
  // AMM's first real invoice continue a sequence that no longer has any
  // invoices behind it.
  const counters = await prisma.invoiceCounter.updateMany({ data: { lastSequence: 0 } });
  console.log(`\nreset ${counters.count} invoice counter(s) to 0`);

  console.log(`\nRemaining (should be real data only):`);
  console.log(`   clients   ${(await prisma.client.count()).toLocaleString()}  (NULL externalRef: ${await prisma.client.count({ where: { externalRef: null } })})`);
  console.log(`   leads     ${(await prisma.lead.count()).toLocaleString()}  (NULL externalRef: ${await prisma.lead.count({ where: { externalRef: null } })})`);
  console.log(`   vendors   ${(await prisma.vendor.count()).toLocaleString()}  (NULL externalRef: ${await prisma.vendor.count({ where: { externalRef: null } })})`);
  console.log(`   projects  ${(await prisma.project.count()).toLocaleString()}  (NULL externalRef: ${await prisma.project.count({ where: { externalRef: null } })})`);
  console.log(`   documents ${(await prisma.document.count()).toLocaleString()}`);
  console.log(`   users     ${(await prisma.user.count()).toLocaleString()}  (kept — only login path; see file header)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
