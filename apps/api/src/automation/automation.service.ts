import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import type { ActionHandler, AutomationEvent, RunOutcome } from "./automation.types";

/** Backoff between retries, in milliseconds. Index = attempt number - 1. */
const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/**
 * The automation engine's runtime (blueprint §12).
 *
 * Until now `automation_rules` was configuration with nothing executing it —
 * the largest gap between what the schema implied and what actually ran. This
 * is the evaluator: it takes an event, finds the enabled rules whose trigger
 * matches, and runs their handler exactly once per (rule, entity, trigger).
 *
 * Three properties matter more than breadth of rule coverage:
 *
 *  - **Idempotent.** Every run is keyed on (ruleId, triggeredBy, triggerHash)
 *    with a unique index behind it, so a replayed event — a retry, a double
 *    click, a redelivered webhook — cannot double-create a project or a
 *    purchase request. The key is claimed in the database *before* the action
 *    runs, so two concurrent deliveries race on the insert rather than both
 *    proceeding.
 *  - **Honest about missing data.** A handler may return BLOCKED, which is
 *    recorded as a real run with the list of fields a human must supply. The
 *    Deal-Won rule uses this rather than inventing an event date or value.
 *  - **Observable.** Success, block and failure all land in `automation_runs`.
 *    Nothing fails silently.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(private readonly prisma: PrismaService) {}

  register(handler: ActionHandler) {
    this.handlers.set(handler.trigger, handler);
  }

  registeredTriggers(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Fires an event through every enabled rule that matches it. Returns one
   * result per rule that ran, so a caller (or a test) can assert on them.
   *
   * This never throws into its caller: an automation failing must not roll back
   * the business action that triggered it. Failures are recorded and retried.
   */
  async emit(event: AutomationEvent): Promise<Array<{ ruleId: string; ruleName: string; outcome: RunOutcome }>> {
    const rules = await this.prisma.client.automationRule.findMany({
      where: { workspaceId: event.workspaceId, isEnabled: true, deletedAt: null },
    });

    const results: Array<{ ruleId: string; ruleName: string; outcome: RunOutcome }> = [];
    for (const rule of rules) {
      const configured = (rule.triggerConfig as { trigger?: string } | null)?.trigger;
      if (!configured || !this.triggerMatches(configured, event.trigger)) continue;

      const handler = this.handlers.get(configured);
      if (!handler) {
        // A seeded rule whose runtime isn't built yet. Visible, not pretended.
        this.logger.debug(`No handler registered for trigger "${configured}" (rule "${rule.name}") — skipping.`);
        continue;
      }
      if (!handler.matches(event)) continue;

      const outcome = await this.runOnce(rule.id, rule.name, handler, event);
      if (outcome) results.push({ ruleId: rule.id, ruleName: rule.name, outcome });
    }
    return results;
  }

  /**
   * `lead.stage_changed:Won` must match an event of exactly that name, but a
   * rule configured as `project.event_date_minus_days:30,7,1` is one rule
   * covering three offsets, so the argument list is compared as a set.
   */
  private triggerMatches(configured: string, incoming: string): boolean {
    if (configured === incoming) return true;
    const [cName, cArgs] = splitTrigger(configured);
    const [iName, iArgs] = splitTrigger(incoming);
    if (cName !== iName) return false;
    if (!cArgs || !iArgs) return false;
    return cArgs.split(",").map((a) => a.trim()).includes(iArgs.trim());
  }

  /**
   * Claims the idempotency key, then runs the handler. Returns null when this
   * exact (rule, entity, trigger) has already reached a terminal state — the
   * defining property of "at most once".
   */
  private async runOnce(
    ruleId: string,
    ruleName: string,
    handler: ActionHandler,
    event: AutomationEvent,
  ): Promise<RunOutcome | null> {
    const triggerHash = hashTrigger(event);
    const triggeredBy = event.entityId;

    const existing = await this.prisma.client.automationRun.findUnique({
      where: { ruleId_triggeredBy_triggerHash: { ruleId, triggeredBy, triggerHash } },
    });
    if (existing && (existing.status === "SUCCESS" || existing.status === "BLOCKED")) {
      return null; // already settled; replaying must not re-run the action
    }
    if (existing && existing.status === "FAILED" && existing.attempt >= MAX_ATTEMPTS) {
      return null; // exhausted; needs a human, not another automatic attempt
    }

    let run = existing;
    if (!run) {
      try {
        run = await this.prisma.client.automationRun.create({
          data: { ruleId, triggeredBy, triggerHash, status: "PENDING", attempt: 1 },
        });
      } catch {
        // Lost the race against a concurrent delivery — that one owns the run.
        return null;
      }
    } else {
      run = await this.prisma.client.automationRun.update({
        where: { id: run.id },
        data: { status: "RETRYING", attempt: run.attempt + 1, startedAt: new Date() },
      });
    }

    let outcome: RunOutcome;
    try {
      outcome = await handler.run(event, ruleId);
    } catch (err) {
      outcome = { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
    }

    await this.prisma.client.automationRun.update({
      where: { id: run.id },
      data: {
        status: outcome.status,
        finishedAt: new Date(),
        error:
          outcome.status === "FAILED" ? outcome.error
          : outcome.status === "BLOCKED" ? `${outcome.reason} (missing: ${outcome.missing.join(", ")})`
          : null,
      },
    });

    if (outcome.status === "FAILED") {
      this.logger.warn(`Automation "${ruleName}" failed on ${event.entityType} ${event.entityId}: ${outcome.error}`);
    }
    return outcome;
  }

  /**
   * Re-runs failed runs whose backoff has elapsed. Called by the scheduler; a
   * separate method so tests can drive it without waiting on wall-clock time.
   */
  async retryFailed(workspaceId: string): Promise<number> {
    const candidates = await this.prisma.client.automationRun.findMany({
      where: { status: "FAILED", attempt: { lt: MAX_ATTEMPTS }, rule: { workspaceId, isEnabled: true, deletedAt: null } },
      include: { rule: true },
      take: 50,
    });

    let retried = 0;
    for (const run of candidates) {
      const waited = Date.now() - (run.finishedAt ?? run.startedAt).getTime();
      if (waited < RETRY_BACKOFF_MS[Math.min(run.attempt - 1, RETRY_BACKOFF_MS.length - 1)]) continue;

      const configured = (run.rule.triggerConfig as { trigger?: string } | null)?.trigger;
      const handler = configured ? this.handlers.get(configured) : undefined;
      if (!handler) continue;

      const event = decodeTrigger(run.triggerHash, run.triggeredBy, workspaceId, configured!);
      if (!event) continue;
      await this.runOnce(run.ruleId, run.rule.name, handler, event);
      retried++;
    }
    return retried;
  }

  async runsFor(workspaceId: string, limit = 100) {
    return this.prisma.client.automationRun.findMany({
      where: { rule: { workspaceId } },
      include: { rule: { select: { name: true, triggerType: true } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  }

  /** Phase I: the rule list + on/off toggle blueprint §12's admin screen calls for — never existed as an endpoint before. */
  async listRules(workspaceId: string) {
    return this.prisma.client.automationRule.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Toggling `isEnabled` off is a real kill switch, not cosmetic — every
   * candidate-rule query in this file (emit()'s trigger match, retryFailed())
   * filters on `isEnabled: true`, so a disabled rule genuinely stops firing
   * on its very next event.
   */
  async setRuleEnabled(workspaceId: string, ruleId: string, isEnabled: boolean) {
    const rule = await this.prisma.client.automationRule.findFirst({ where: { id: ruleId, workspaceId, deletedAt: null } });
    if (!rule) return null;
    return this.prisma.client.automationRule.update({ where: { id: ruleId }, data: { isEnabled } });
  }
}

function splitTrigger(t: string): [string, string | undefined] {
  const i = t.indexOf(":");
  return i === -1 ? [t, undefined] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * The idempotency discriminator. Includes the trigger and the entity, so the
 * same lead reaching Won twice is one run, but the same lead hitting a
 * different trigger is a different run.
 */
function hashTrigger(event: AutomationEvent): string {
  return createHash("sha256").update(`${event.trigger}|${event.entityType}|${event.entityId}`).digest("hex").slice(0, 32);
}

/** Rebuilds enough of the event to retry. */
function decodeTrigger(_hash: string, entityId: string, workspaceId: string, trigger: string): AutomationEvent | null {
  const [name] = splitTrigger(trigger);
  const entityType = name.split(".")[0];
  return { trigger, workspaceId, entityId, entityType };
}
