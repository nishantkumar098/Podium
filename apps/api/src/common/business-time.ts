/**
 * AMM Brands operates in India. Every server in this system runs UTC, every
 * timestamp is stored UTC, and until now nothing anywhere named the timezone
 * the business actually works in — so every date boundary silently meant
 * "midnight in London", 05:30 in Jaipur.
 *
 * That is not a cosmetic difference. `dueDate: { lt: now }` against a due date
 * stored as midnight UTC marks an invoice OVERDUE at 05:30 IST **on the
 * morning of the day it is due** — a full day early, to a client who is not
 * late. Found while tracing the worker's responsibilities on 2026-09-16.
 *
 * The rule this module encodes: timestamps stay UTC everywhere, and every
 * *calendar* decision — is this date past, which day does this fall on, what
 * date do we show a person — is resolved in business time.
 */

/** IANA zone for AMM's operating timezone. Not configurable today; one company, one country. */
export const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * A DURATION-based SLA needs none of this. "90 minutes from ready" is 90
 * minutes in every timezone, so the flow-engine SLA clock is timezone-neutral
 * by construction and deliberately left that way.
 *
 * What is NOT neutral is whether that clock should run overnight: a step
 * becoming ready at 18:45 IST with a 90-minute SLA breaches at 20:15, with
 * nobody at a desk. Business-hours SLAs are a policy decision for AMM, not one
 * to invent here — recorded as AMM-DECISION-SLA-HOURS in the evidence
 * register. Until it is answered the clock runs continuously, which is the
 * existing behaviour and the conservative one (it escalates too eagerly rather
 * than too late).
 */
export const SLA_CLOCK_RUNS_OUTSIDE_BUSINESS_HOURS = true;

/**
 * The last instant of a given date **in business time**, as a UTC Date.
 *
 * A due date of 2026-09-16 means "we expect the money by the end of the 16th
 * in Jaipur", which is 2026-09-16T18:29:59.999Z. Anything before that is not
 * yet overdue.
 */
export function endOfBusinessDay(date: Date): Date {
  const { year, month, day } = businessDateParts(date);
  // Start from the next calendar day's business midnight and step back 1ms.
  return new Date(businessMidnightUtc(year, month, day + 1).getTime() - 1);
}

/** The calendar date, in business time, as an ISO `YYYY-MM-DD` string — what a person should be shown. */
export function businessDateString(date: Date): string {
  const { year, month, day } = businessDateParts(date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Y/M/D as they read on a wall calendar in business time. */
export function businessDateParts(date: Date): { year: number; month: number; day: number } {
  // Intl is the only correct way to do this: it carries the zone's real
  // offset rules rather than a hardcoded +05:30 that a future zone change,
  // or a second operating country, would silently invalidate.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The UTC instant of business-midnight starting the given business date.
 * `day` may overflow its month (day 32, day 0) — resolved the way Date does.
 */
function businessMidnightUtc(year: number, month: number, day: number): Date {
  // Guess at UTC midnight, measure the zone's offset at that instant, correct.
  // Two passes because the offset itself can differ either side of the guess
  // (it does not in Asia/Kolkata, which has no DST, but this must not be the
  // one place that breaks if AMM ever operates somewhere that does).
  let guess = Date.UTC(year, month - 1, day);
  for (let i = 0; i < 2; i++) {
    guess -= offsetMs(new Date(guess));
    const parts = businessDateParts(new Date(guess));
    const target = new Date(Date.UTC(year, month - 1, day));
    if (parts.day === target.getUTCDate() && parts.month === target.getUTCMonth() + 1) break;
    guess = Date.UTC(year, month - 1, day);
    guess -= offsetMs(new Date(guess - offsetMs(new Date(guess))));
  }
  return new Date(guess);
}

/** The zone's UTC offset, in milliseconds, at a given instant. */
function offsetMs(at: Date): number {
  const asUtc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  const asBusiness = new Date(at.toLocaleString("en-US", { timeZone: BUSINESS_TIMEZONE }));
  return asBusiness.getTime() - asUtc.getTime();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
