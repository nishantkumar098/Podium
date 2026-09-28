import { STATUS_PILL_COLOR } from "@podium/ui";

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_PILL_COLOR[status] ?? "gray";
  return <span className={`pill ${color}`}>{status.replace(/_/g, " ")}</span>;
}
