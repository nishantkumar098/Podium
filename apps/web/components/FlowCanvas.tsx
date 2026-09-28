type FlowCanvasStep = {
  id: string;
  key: string;
  name: string;
  role: string;
  status: string;
};

const STATUS_LABEL: Record<string, string> = {
  LOCKED: "Waiting",
  READY: "Up next",
  ACTIVE: "In progress",
  COMPLETED: "Done",
  BLOCKED: "Blocked",
  ESCALATED: "Escalated",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

/**
 * A simplified flow visualization: one card per step in template order,
 * colored by state (locked/ready/active/done), matching the prototype's
 * `.fnode` visual language. The full dependency-column layout (the
 * prototype's `flowCanvas()`) needs the dependsOn edges, which this
 * lightweight card list doesn't require — good enough for "what's the
 * state of this flow," not yet the interactive handoff canvas.
 */
export function FlowCanvas({ steps }: { steps: FlowCanvasStep[] }) {
  const ordered = [...steps].sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="flow-canvas" style={{ flexWrap: "wrap" }}>
      {ordered.map((s) => (
        <div key={s.id} className="flow-col" style={{ flex: "0 0 214px" }}>
          <div className={`fnode ${s.status}`}>
            <span className="fn-state">
              <span className={`pill ${s.status === "COMPLETED" ? "green" : s.status === "READY" ? "amber" : s.status === "ACTIVE" ? "blue" : "gray"}`}>
                {STATUS_LABEL[s.status] ?? s.status}
              </span>
            </span>
            <div className="fn-name">{s.name}</div>
            <div className="fn-who">{s.role}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
