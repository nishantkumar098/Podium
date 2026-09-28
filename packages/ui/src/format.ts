/** Formatting helpers ported verbatim from the prototype's fmtINR/fmtDate/initials. */

export function fmtINR(n: number): string {
  if (n >= 10000000) return "₹" + (n / 10000000).toFixed(2) + " Cr";
  if (n >= 100000) return "₹" + (n / 100000).toFixed(1) + " L";
  return "₹" + n.toLocaleString("en-IN");
}

export function fmtDate(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function daysTo(d: string | Date): number {
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
}

export function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

export const STATUS_PILL_COLOR: Record<string, "green" | "red" | "amber" | "blue" | "gray"> = {
  OPEN: "red",
  PENDING: "amber",
  APPROVED: "green",
  COMPLETED: "green",
  PAID: "green",
  MITIGATING: "blue",
  MONITORING: "gray",
  IN_PROGRESS: "blue",
  CLIENT_REVIEW: "amber",
  PLANNED: "gray",
  PLANNING: "gray",
  BACKLOG: "gray",
  ISSUED: "blue",
  PARTIALLY_PAID: "amber",
  OVERDUE: "red",
  DRAFT: "gray",
  REJECTED: "red",
  CANCELLED: "gray",
  // Lead pipeline stages (Phase F.5).
  LEAD: "gray",
  QUALIFIED: "blue",
  PROPOSAL: "amber",
  NEGOTIATION: "amber",
  WON: "green",
  LOST: "red",
  // Automation run statuses (Phase I).
  SUCCESS: "green",
  FAILED: "red",
  RETRYING: "amber",
  BLOCKED: "amber",
};

export const HEALTH_COLOR: Record<string, string> = { GREEN: "green", AMBER: "amber", RED: "red" };
