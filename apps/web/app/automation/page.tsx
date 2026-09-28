"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Pill } from "../../components/OpsUi";
import { api, ApiError } from "../../lib/api";
import type { AutomationRuleDto, AutomationRunDto } from "../../lib/types";

/** "lead.stage_changed:WON" → "Lead stage changed · WON". */
function readableTrigger(trigger: string): string {
  const [event, arg] = trigger.split(":");
  const words = event.replace(/[._]/g, " ");
  return arg ? `${words.charAt(0).toUpperCase() + words.slice(1)} · ${arg.replace(/_/g, " ")}` : words.charAt(0).toUpperCase() + words.slice(1);
}

function actionLabel(a: AutomationRuleDto["actions"][number]): string {
  const type = typeof a === "string" ? a : (a.type ?? "action");
  return type.replace(/[._]/g, " ");
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/**
 * Automation: the real rule engine — each rule is a trigger and the actions
 * it fires, with the runs it has actually performed.
 */
export default function AutomationPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: rules, isLoading } = useQuery({ queryKey: ["automation-rules"], queryFn: () => api.get<AutomationRuleDto[]>("/automation/rules") });
  const { data: runs } = useQuery({ queryKey: ["automation-runs"], queryFn: () => api.get<AutomationRunDto[]>("/automation/runs?limit=30") });

  const toggle = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) => api.patch(`/automation/rules/${id}`, { isEnabled }),
    onSuccess: () => {
      setError(null);
      return qc.invalidateQueries({ queryKey: ["automation-rules"] });
    },
    onError: (e: ApiError) => setError(e.message),
  });
  const sweep = useMutation({
    mutationFn: () => api.post<{ checked?: number; fired?: number }>("/automation/sweep"),
    onSuccess: () => {
      setError(null);
      return Promise.all([qc.invalidateQueries({ queryKey: ["automation-runs"] }), qc.invalidateQueries({ queryKey: ["nav-counts"] })]);
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const active = (rules ?? []).filter((r) => r.isEnabled).length;
  const failed = (runs ?? []).filter((r) => r.status === "FAILED").length;

  return (
    <AppShell crumb="Automation">
      <div className="page-head">
        <div>
          <div className="page-title">Automation</div>
          <div className="page-sub">
            {active} active rule{active === 1 ? "" : "s"} of {rules?.length ?? 0} · each fires on a real event and records every run
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" disabled={sweep.isPending} onClick={() => sweep.mutate()} title="Run the time-based checks now (licence deadlines, overdue invoices, SLA breaches)">
            {sweep.isPending ? "Checking…" : "Run time checks now"}
          </button>
        </div>
      </div>

      {error && (
        <div className="notice red" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {sweep.isSuccess && <div className="notice" style={{ marginBottom: 12 }}>Time-based checks ran. Anything due appears in the runs below.</div>}
      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && (rules?.length ?? 0) === 0 && <div className="empty">No automation rules are configured.</div>}

      <div className="section-block">
        {rules?.map((r) => (
          <div key={r.id} className="autorule">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <b>{r.name}</b>
              <div
                className={`toggle ${r.isEnabled ? "on" : ""}`}
                role="switch"
                aria-checked={r.isEnabled}
                aria-label={`${r.isEnabled ? "Disable" : "Enable"} ${r.name}`}
                tabIndex={0}
                title={r.isEnabled ? "Enabled — click to pause" : "Paused — click to enable"}
                onClick={() => !toggle.isPending && toggle.mutate({ id: r.id, isEnabled: !r.isEnabled })}
                onKeyDown={(e) => e.key === "Enter" && toggle.mutate({ id: r.id, isEnabled: !r.isEnabled })}
              >
                <div className="knob" />
              </div>
            </div>
            <div className="flow">
              <span className="chip">WHEN: {readableTrigger(r.triggerType)}</span>
              {r.actions.map((a, i) => (
                <span key={i}>
                  <span className="arrow"> → </span>
                  <span className="chip">{actionLabel(a)}</span>
                </span>
              ))}
              {r.actions.length === 0 && (
                <>
                  <span className="arrow"> → </span>
                  <span className="chip">no actions configured</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-title">
          Recent runs {failed > 0 && <span className="pill red">{failed} failed</span>}
        </div>
        {(runs?.length ?? 0) === 0 && <div className="empty">No runs yet. A rule runs when its event happens — win a deal, receive stock, miss an SLA.</div>}
        {(runs?.length ?? 0) > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Status</th>
                <th>Started</th>
                <th className="num">Attempt</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {runs!.map((run) => (
                <tr key={run.id}>
                  <td className="small">{run.rule.name}</td>
                  <td>
                    <Pill value={run.status} />
                  </td>
                  <td className="small mono">{when(run.startedAt)}</td>
                  <td className="num">{run.attempt}</td>
                  <td className="small faint">{run.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
