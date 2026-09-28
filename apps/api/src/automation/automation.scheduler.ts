import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { AutomationService } from "./automation.service";

/**
 * Drives the triggers nothing else can raise: time-relative ones (a licence
 * reaching T-7 is not an action anybody takes) and threshold ones (stock is
 * below its reorder level because of a movement that may have happened hours
 * ago).
 *
 * Event triggers do NOT come from here — they are emitted inline by the code
 * that performs the action, so a Won lead fires its automation immediately
 * rather than up to an hour later.
 *
 * Phase H: moved off the API process's own @nestjs/schedule cron and onto
 * the `workers/` BullMQ scheduler (see workers/src/main.ts's
 * automation.tick job) — the same reasoning and the same fix as
 * FlowSlaService. `sweep()`/`sweepWorkspace()` are unchanged and still
 * directly callable by the worker or by a test.
 */
@Injectable()
export class AutomationScheduler {
  private readonly logger = new Logger(AutomationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: AutomationService,
  ) {}

  async sweep() {
    const workspaces = await this.prisma.client.workspace.findMany({ where: { deletedAt: null }, select: { id: true } });
    for (const ws of workspaces) {
      await this.sweepWorkspace(ws.id);
    }
  }

  /** Exposed so a test (or an admin endpoint) can drive a sweep deterministically. */
  async sweepWorkspace(workspaceId: string) {
    const licences = await this.sweepLicences(workspaceId);
    const lowStock = await this.sweepLowStock(workspaceId);
    const retried = await this.automation.retryFailed(workspaceId);
    return { licences, lowStock, retried };
  }

  /**
   * Licences inside their own escalation window. Uses each licence's
   * `escalationOffsetDays` rather than a hardcoded 7, and only fires for
   * licences that are genuinely not approved yet.
   */
  private async sweepLicences(workspaceId: string) {
    const pending = await this.prisma.client.licence.findMany({
      where: { workspaceId, deletedAt: null, status: { in: ["NOT_APPLIED", "APPLIED"] } },
      select: { id: true, dueDate: true, escalationOffsetDays: true },
    });

    let fired = 0;
    const now = Date.now();
    for (const l of pending) {
      const windowOpensAt = l.dueDate.getTime() - l.escalationOffsetDays * 86_400_000;
      if (now < windowOpensAt) continue;
      const results = await this.automation.emit({
        trigger: `licence.due_date_minus_days:${l.escalationOffsetDays}`,
        workspaceId,
        entityId: l.id,
        entityType: "licence",
      });
      if (results.length) fired++;
    }
    return fired;
  }

  /** Balances that have fallen below their reorder level. */
  private async sweepLowStock(workspaceId: string) {
    const low = await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      SELECT b.id FROM inventory_balances b
        JOIN inventory_items i ON i.id = b.sku_id
       WHERE i.workspace_id = ${workspaceId}::uuid
         AND i.deleted_at IS NULL
         AND b.reorder_level > 0
         AND b.qty_on_hand < b.reorder_level`;

    let fired = 0;
    for (const b of low) {
      const results = await this.automation.emit({
        trigger: "inventory_balance.available_lt_reorder_level",
        workspaceId,
        entityId: b.id,
        entityType: "inventory_balance",
      });
      if (results.length) fired++;
    }
    return fired;
  }
}
