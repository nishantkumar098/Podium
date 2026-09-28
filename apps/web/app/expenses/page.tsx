"use client";

import { fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar, FormField, Modal } from "../../components/GovernanceUi";
import { Pill, ProjectSelect } from "../../components/OpsUi";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { ExpenseDto } from "../../lib/types";

const FILTERS = ["ALL", "PENDING", "APPROVED", "REJECTED", "REIMBURSED"] as const;
const CATEGORIES = ["Travel", "Local conveyance", "Supplies", "Meals", "Permits & fees", "Stock purchase", "Other"];

export default function ExpensesPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["expenses"], queryFn: () => api.get<ExpenseDto[]>("/expenses") });
  // Same cached request the sidebar makes — tells us whether this person approves claims.
  const { data: shell } = useQuery({ queryKey: ["shell"], queryFn: () => api.get<{ permissions: string[] }>("/users/me/shell"), staleTime: 30 * 60_000 });
  const approver = !!shell?.permissions.includes("expenses:approve");

  const all = data ?? [];
  const rows = useMemo(() => all.filter((e) => filter === "ALL" || e.status === filter), [all, filter]);
  const sum = (xs: ExpenseDto[]) => xs.reduce((s, e) => s + Number(e.amount), 0);
  const pending = all.filter((e) => e.status === "PENDING");
  const approved = all.filter((e) => e.status === "APPROVED");
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const reimbursedThisMonth = all.filter((e) => e.status === "REIMBURSED" && e.reimbursedAt && new Date(e.reimbursedAt) >= monthStart);
  const mine = all.filter((e) => e.user.id === user?.id);

  const refresh = () => qc.invalidateQueries({ queryKey: ["expenses"] });
  const onError = (e: ApiError) => setError(e.message);
  const decide = useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: string; reason?: string }) => api.post(`/expenses/${id}/decide`, { decision, reason }),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError,
  });
  const reimburse = useMutation({
    mutationFn: (id: string) => api.post(`/expenses/${id}/reimburse`),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError,
  });

  return (
    <AppShell crumb="Expenses">
      <div className="page-head">
        <div>
          <div className="page-title">Expense claims</div>
          <div className="page-sub">
            {approver ? "All claims you can see — you can approve anyone's but your own" : "Your claims. Finance approves and reimburses."}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setClaiming(true)}>
            + New claim
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

      <div className="grid g4 section-block">
        <div className="stat" style={{ borderLeftColor: "var(--amber)" }}>
          <div className="k">Awaiting approval</div>
          <div className="v">{fmtINR(sum(pending))}</div>
          <div className="d">{pending.length} claims</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
          <div className="k">Approved, to pay</div>
          <div className="v">{fmtINR(sum(approved))}</div>
          <div className="d">{approved.length} claims</div>
        </div>
        <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
          <div className="k">Reimbursed this month</div>
          <div className="v">{fmtINR(sum(reimbursedThisMonth))}</div>
        </div>
        <div className="stat">
          <div className="k">Your claims</div>
          <div className="v">{mine.length}</div>
          <div className="d">{fmtINR(sum(mine))}</div>
        </div>
      </div>

      <div className="chips" style={{ marginBottom: 10 }}>
        {FILTERS.map((f) => (
          <button key={f} className={`chipbtn ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
            {f !== "ALL" && ` (${all.filter((e) => e.status === f).length})`}
          </button>
        ))}
      </div>

      <div className="panel">
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Category</th>
                <th>Project</th>
                <th>Note</th>
                <th>Date</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={8} className="empty">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    {all.length === 0 ? "No claims yet. Add one with + New claim — Finance is notified to approve it." : "No claims with this status."}
                  </td>
                </tr>
              )}
              {rows.map((e) => {
                const own = e.user.id === user?.id;
                return (
                  <tr key={e.id}>
                    <td>
                      <Avatar name={e.user.name} /> &nbsp;{e.user.name}
                      {own && <span className="small faint"> (you)</span>}
                    </td>
                    <td>{e.category}</td>
                    <td className="small">{e.project.name}</td>
                    <td className="small">{e.note ?? "—"}</td>
                    <td className="mono small">{fmtDate(e.incurredAt)}</td>
                    <td className="num">{fmtINR(Number(e.amount))}</td>
                    <td>
                      <Pill value={e.status === "REIMBURSED" ? "COMPLETED" : e.status} />
                      {e.status === "REIMBURSED" && <div className="small faint">reimbursed</div>}
                      {e.approvedBy && e.status !== "PENDING" && <div className="small faint">by {e.approvedBy.name}</div>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {approver && e.status === "PENDING" && !own && (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="btn-ok btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: e.id, decision: "APPROVED" })}>
                            Approve
                          </button>
                          <DeclineButton onDecline={(reason) => decide.mutate({ id: e.id, decision: "REJECTED", reason })} />
                        </span>
                      )}
                      {e.status === "PENDING" && own && <span className="small faint">Awaiting someone else</span>}
                      {approver && e.status === "APPROVED" && (
                        <button className="btn-ghost btn-sm" disabled={reimburse.isPending} onClick={() => reimburse.mutate(e.id)}>
                          Mark paid
                        </button>
                      )}
                      {e.status === "REJECTED" && e.decisionReason && <span className="small faint">{e.decisionReason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {claiming && (
        <NewClaim
          onClose={() => setClaiming(false)}
          onDone={() => {
            setClaiming(false);
            setError(null);
            void refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function DeclineButton({ onDecline }: { onDecline: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        Decline
      </button>
    );
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <input className="inp" style={{ width: 170 }} autoFocus placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn-warn btn-sm" disabled={!reason.trim()} onClick={() => onDecline(reason.trim())}>
        Decline
      </button>
      <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
        ×
      </button>
    </span>
  );
}

function NewClaim({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ category: "Travel", amount: "", projectId: "", note: "", date: new Date().toISOString().slice(0, 10) });
  const submit = useMutation({
    mutationFn: () =>
      api.post("/expenses", {
        projectId: f.projectId,
        category: f.category,
        amount: Number(f.amount),
        note: f.note.trim() || undefined,
        incurredAt: f.date,
      }),
    onSuccess: onDone,
  });
  const ok = f.projectId && Number(f.amount) > 0;
  return (
    <Modal
      title="New expense claim"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!ok || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting…" : "Submit claim"}
          </button>
        </>
      }
    >
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Category">
          <select className="inp" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Amount (₹)">
          <input className="inp mono" type="number" min={0} step="0.01" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="e.g. 2400" />
        </FormField>
      </div>
      <FormField label="Project">
        <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} />
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Date">
          <input className="inp" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </FormField>
        <FormField label="What was it for?">
          <input className="inp" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Cab to venue recce" />
        </FormField>
      </div>
      {submit.error && <div className="notice red">{(submit.error as Error).message}</div>}
    </Modal>
  );
}
