import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AutomationScheduler } from "../../automation/automation.scheduler";
import { FlowSlaService } from "../../flows/flow-sla.service";
import { InvoicesService } from "../../invoices/invoices.service";

/**
 * Podium's periodic sweeps, run inside the API process.
 *
 * READ THIS BEFORE ENABLING IT. These three jobs used to be `@nestjs/schedule`
 * crons exactly like this, and were deliberately moved out to a Redis-backed
 * BullMQ worker (`workers/src/main.ts`). The reason was correctness, not
 * taste: an in-process cron fires once per process, so the moment a second
 * API instance exists every sweep runs twice. Idempotency keys made that
 * survivable, but survivable-by-accident is not a design.
 *
 * That reason applies to a horizontally-scaled deployment. It does not apply
 * to managed hosting that runs exactly one Node process and offers no Redis
 * at all — there, the Redis worker is not merely unnecessary, it is
 * impossible, and the choice is between in-process crons and no sweeps.
 *
 * So this is opt-in, and off by default: it runs only when
 * PODIUM_INLINE_SCHEDULER=1. The Docker deployment leaves it unset and keeps
 * using the worker. Nothing can accidentally run both, and nothing about the
 * container path changes.
 *
 * Every job calls the same service method the worker calls. There is no
 * second copy of any logic here — the cadences below mirror
 * workers/src/main.ts exactly.
 */
export const INLINE_SCHEDULER_ENABLED = process.env.PODIUM_INLINE_SCHEDULER === "1";

@Injectable()
export class InlineSchedulerService {
  private readonly log = new Logger("Scheduler");
  /**
   * One sweep at a time. The sweeps touch shared financial rows, and a slow
   * run must not be overlapped by the next tick — the minute-by-minute SLA
   * sweep is the one that could realistically catch up with itself.
   */
  private running = false;

  constructor(
    private readonly invoices: InvoicesService,
    private readonly flowSla: FlowSlaService,
    private readonly automation: AutomationScheduler,
  ) {}

  /** 02:00 daily — after midnight, so "past its due date" means a full day has elapsed. */
  @Cron("0 2 * * *")
  async invoiceOverdueSweep() {
    await this.run("invoice.overdue-sweep", async () => {
      const result = await this.invoices.sweepOverdue();
      if (result.transitioned > 0) this.log.log(`${result.transitioned} invoice(s) -> OVERDUE`);
    });
  }

  /** Every minute, same as the worker. */
  @Cron("* * * * *")
  async flowSlaSweep() {
    await this.run("flow.sla-sweep", async () => {
      const result = await this.flowSla.checkSlaBreaches();
      if (result.escalated > 0) this.log.log(`${result.escalated} flow step(s) escalated`);
    });
  }

  /** Every ten minutes, same as the worker. */
  @Cron("*/10 * * * *")
  async automationTick() {
    await this.run("automation.tick", () => this.automation.sweep().then(() => undefined));
  }

  /**
   * A failing sweep must never take the web server down with it: this
   * process is also serving the app, which the worker process was not.
   */
  private async run(name: string, job: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.log.warn(`${name} skipped — the previous sweep is still running`);
      return;
    }
    this.running = true;
    try {
      await job();
    } catch (err) {
      this.log.error(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
