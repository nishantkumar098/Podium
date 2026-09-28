import { NestFactory } from "@nestjs/core";
import { Queue, Worker, type Job } from "bullmq";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { AppModule } from "@podium/api/src/app.module";
import { AutomationScheduler } from "@podium/api/src/automation/automation.scheduler";
import { FlowSlaService } from "@podium/api/src/flows/flow-sla.service";
import { InvoicesService } from "@podium/api/src/invoices/invoices.service";
import { createRedisConnection, QUEUE_NAMES, SCHEDULED_JOBS } from "./queues";

loadEnv({ path: resolve(__dirname, "../../.env") });

/**
 * The Podium background worker.
 *
 * Why this process exists at all: the automation engine, the flow-engine SLA
 * sweep and the invoice overdue sweep were (or would have been) `@nestjs/schedule`
 * crons running inside the API process. That is only correct while exactly
 * one API instance is running — the moment there are two, every scheduled
 * task fires twice. The existing idempotency keys made that survivable, but
 * "survivable because the second run is a no-op" is a mitigation, not a
 * design: it still doubles the load, and any future job without an
 * idempotency key silently double-executes.
 *
 * Here, the schedule lives in Redis as a BullMQ job scheduler. However many
 * worker processes are running, the scheduler produces ONE job per interval
 * and exactly one worker claims it. Correct because only one process runs
 * it, not because running it twice happens to be harmless.
 *
 * The worker bootstraps the API's own Nest module as an *application
 * context* (no HTTP server, no ports bound) so every job runs the exact same
 * service methods the HTTP API and the e2e tests do. There is no second copy
 * of any business logic in this package.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const log = (msg: string) => console.log(`[worker] ${msg}`);

  const connection = createRedisConnection();
  const queue = new Queue(QUEUE_NAMES.scheduled, { connection });

  /**
   * Register the repeatable schedules. `upsertJobScheduler` is idempotent on
   * the scheduler id, so every worker instance booting registers the SAME
   * schedule rather than adding another one.
   */
  await queue.upsertJobScheduler(
    SCHEDULED_JOBS.invoiceOverdueSweep,
    { pattern: "0 2 * * *" }, // 02:00 daily — after midnight, so "past due date" means a whole day has elapsed
    { name: SCHEDULED_JOBS.invoiceOverdueSweep },
  );
  log(`scheduled ${SCHEDULED_JOBS.invoiceOverdueSweep} (daily 02:00)`);

  // Phase H: these two were @nestjs/schedule crons running inside the API
  // process (FlowSlaService, AutomationScheduler) — exactly the
  // double-fires-across-instances problem this worker package exists to
  // fix. Their own doc comments called this out as "the follow-up"; this is
  // it. Same cadence as before (every minute / every 10 minutes), just
  // scheduled once in Redis instead of once per running API process.
  await queue.upsertJobScheduler(
    SCHEDULED_JOBS.flowSlaSweep,
    { pattern: "* * * * *" },
    { name: SCHEDULED_JOBS.flowSlaSweep },
  );
  log(`scheduled ${SCHEDULED_JOBS.flowSlaSweep} (every minute)`);

  await queue.upsertJobScheduler(
    SCHEDULED_JOBS.automationTick,
    { pattern: "*/10 * * * *" },
    { name: SCHEDULED_JOBS.automationTick },
  );
  log(`scheduled ${SCHEDULED_JOBS.automationTick} (every 10 minutes)`);

  const invoices = app.get(InvoicesService);
  const flowSla = app.get(FlowSlaService);
  const automationScheduler = app.get(AutomationScheduler);

  const worker = new Worker(
    QUEUE_NAMES.scheduled,
    async (job: Job) => {
      switch (job.name) {
        case SCHEDULED_JOBS.invoiceOverdueSweep: {
          const result = await invoices.sweepOverdue();
          log(`${job.name}: ${result.transitioned} invoice(s) -> OVERDUE`);
          return result;
        }
        case SCHEDULED_JOBS.flowSlaSweep: {
          const result = await flowSla.checkSlaBreaches();
          if (result.escalated > 0) log(`${job.name}: ${result.escalated} flow step(s) escalated`);
          return result;
        }
        case SCHEDULED_JOBS.automationTick: {
          const result = await automationScheduler.sweep();
          return result;
        }
        default:
          // An unknown job name is a deployment mismatch (a newer API
          // enqueued something this worker doesn't understand). Throw so it
          // lands in the failed set and is visible, rather than being
          // silently acknowledged and lost.
          throw new Error(`Unknown scheduled job "${job.name}"`);
      }
    },
    {
      connection: createRedisConnection(),
      // One job at a time: these sweeps touch shared financial rows and
      // there is no benefit to running two of them concurrently.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => console.error(`[worker] job ${job?.name} failed:`, err.message));

  const shutdown = async (signal: string) => {
    log(`${signal} received — draining`);
    await worker.close();
    await queue.close();
    await connection.quit();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log("ready");
}

bootstrap().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
