"use client";

import { fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { BudgetDto, BudgetVarianceDto } from "../lib/types";

/**
 * Budget vs. actual for one project.
 *
 * Everything shown is served by the API — nothing is recomputed here. In
 * particular the variance figures come from GET /budgets/variance, which
 * counts only APPROVED/REIMBURSED expenses, so a pending claim never inflates
 * "spent". Purchase-order spend is shown as its own line because purchase
 * orders carry no category and cannot honestly be attributed to one.
 */
export function BudgetPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: variance, isLoading } = useQuery({
    queryKey: ["budget-variance", projectId],
    queryFn: () => api.get<BudgetVarianceDto>(`/budgets/variance?projectId=${projectId}`),
  });
  const { data: budget } = useQuery({
    queryKey: ["budget", projectId],
    queryFn: () => api.get<BudgetDto | null>(`/budgets?projectId=${projectId}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["budget-variance", projectId] });
    qc.invalidateQueries({ queryKey: ["budget", projectId] });
  };

  if (isLoading) return <div className="panel"><div className="empty">Loading budget…</div></div>;
  if (!variance) return null;

  const overspent = (v: number) => v < 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {editing ? (
        <BudgetEditor
          projectId={projectId}
          budget={budget ?? null}
          onDone={() => { setEditing(false); setError(null); refresh(); }}
          onCancel={() => setEditing(false)}
          onError={(e) => setError(e.message)}
        />
      ) : (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="panel-title" style={{ marginBottom: 0 }}>Budget vs actual</div>
            <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
              {variance.hasBudget ? "Edit budget" : "Set a budget"}
            </button>
          </div>

          {!variance.hasBudget && (
            <div className="empty" style={{ padding: 16 }}>
              No budget set for this project. Real spend below is still recorded.
            </div>
          )}

          {variance.hasBudget && (
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="tright">Planned</th>
                  <th className="tright">Actual</th>
                  <th className="tright">Variance</th>
                  <th className="tright">%</th>
                </tr>
              </thead>
              <tbody>
                {variance.lines.map((l) => (
                  <tr key={l.category}>
                    <td>{l.category}</td>
                    <td className="tright mono">{fmtINR(l.plannedAmount)}</td>
                    <td className="tright mono">{fmtINR(l.actualAmount)}</td>
                    <td className="tright mono" style={{ color: overspent(l.variance) ? "var(--red)" : "var(--green)" }}>
                      {overspent(l.variance) ? "−" : "+"}{fmtINR(Math.abs(l.variance))}
                    </td>
                    <td className="tright mono small">{l.variancePct === null ? "—" : `${l.variancePct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {variance.unbudgetedSpend.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="small" style={{ color: "var(--text-dim)", fontWeight: 500, marginBottom: 5 }}>
                Unbudgeted spend — real costs in categories with no budget line
              </div>
              <table>
                <tbody>
                  {variance.unbudgetedSpend.map((u) => (
                    <tr key={u.category}>
                      <td>{u.category}</td>
                      <td className="tright mono" style={{ color: "var(--red)" }}>{fmtINR(u.actualAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 10 }}>
            <Row label="Planned total" value={fmtINR(variance.totals.planned)} />
            <Row label="Actual expenses (approved or reimbursed only)" value={fmtINR(variance.totals.actualExpenses)} />
            <Row
              label="Received purchase orders — not attributable to a category"
              value={fmtINR(variance.purchaseOrderSpend)}
            />
            <div style={{ borderTop: "1px solid var(--line)", margin: "8px 0" }} />
            <Row label="All committed spend" value={fmtINR(variance.totals.actualAllCommitted)} strong />
            {variance.hasBudget && (
              <Row
                label="Variance against plan (expenses only)"
                value={`${overspent(variance.totals.variance) ? "−" : "+"}${fmtINR(Math.abs(variance.totals.variance))}`}
                strong
                tone={overspent(variance.totals.variance) ? "red" : "green"}
              />
            )}
          </div>
          <div className="small" style={{ color: "var(--text-faint)", marginTop: 10 }}>
            Purchase orders carry no budget category, so their spend is reported separately rather than
            distributed across the lines above.
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "red" | "green" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: strong ? 13 : 12.3, gap: 16 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono" style={{ fontWeight: strong ? 600 : 400, color: tone === "red" ? "var(--red)" : tone === "green" ? "var(--green)" : undefined, whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );
}

interface EditLine { category: string; plannedAmount: string }

function BudgetEditor({
  projectId,
  budget,
  onDone,
  onCancel,
  onError,
}: {
  projectId: string;
  budget: BudgetDto | null;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: ApiError) => void;
}) {
  const [lines, setLines] = useState<EditLine[]>(
    budget?.lines.length
      ? budget.lines.map((l) => ({ category: l.category, plannedAmount: String(Number(l.plannedAmount)) }))
      : [{ category: "", plannedAmount: "" }],
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        lines: lines
          .filter((l) => l.category.trim() && l.plannedAmount !== "")
          .map((l) => ({ category: l.category.trim(), plannedAmount: Number(l.plannedAmount) })),
      };
      return budget
        ? api.patch(`/budgets/${budget.id}`, payload)
        : api.post("/budgets", { projectId, ...payload });
    },
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const patch = (i: number, p: Partial<EditLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...p } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.plannedAmount) || 0), 0);
  const valid = lines.some((l) => l.category.trim() && l.plannedAmount !== "");

  return (
    <div className="panel">
      <div className="panel-title">{budget ? "Edit budget" : "Set a budget"}</div>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th className="tright" style={{ width: 180 }}>Planned amount</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <input className="inp" style={{ width: "100%" }} placeholder="Catering" value={l.category} onChange={(e) => patch(i, { category: e.target.value })} />
              </td>
              <td>
                <input className="inp tright mono" style={{ width: "100%" }} type="number" min="0" step="0.01" value={l.plannedAmount} onChange={(e) => patch(i, { plannedAmount: e.target.value })} />
              </td>
              <td>
                {lines.length > 1 && (
                  <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => [...prev, { category: "", plannedAmount: "" }])}>
          + Add category
        </button>
        <span className="small mono" style={{ color: "var(--text-dim)" }}>Planned total {fmtINR(total)}</span>
      </div>
      <div className="page-actions" style={{ marginTop: 14 }}>
        <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save budget"}
        </button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
