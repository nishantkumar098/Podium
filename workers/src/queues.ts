import IORedis from "ioredis";

/**
 * One queue for every scheduled/background job in Podium.
 *
 * These names are the contract between the API (which may enqueue ad hoc
 * jobs) and this worker process (which consumes them). They are strings in
 * one place so a typo cannot silently create a second, never-consumed queue.
 */
export const QUEUE_NAMES = {
  /** Periodic maintenance: invoice overdue sweep, flow SLA sweep, automation tick. */
  scheduled: "podium.scheduled",
} as const;

/** Job names within the scheduled queue. */
export const SCHEDULED_JOBS = {
  invoiceOverdueSweep: "invoice.overdue-sweep",
  flowSlaSweep: "flow.sla-sweep",
  automationTick: "automation.tick",
} as const;

export type ScheduledJobName = (typeof SCHEDULED_JOBS)[keyof typeof SCHEDULED_JOBS];

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands — without it ioredis aborts the blocking BRPOPLPUSH the
 * worker waits on and the worker dies after a brief Redis hiccup instead of
 * reconnecting.
 */
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(url, { maxRetriesPerRequest: null });
}
