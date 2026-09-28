"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { NewRiskModal, Pill, title } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface Risk {
  id: string;
  title: string;
  severity: string;
  status: string;
  impact: string | null;
  project: { id: string; name: string };
  owner: { id: string; name: string };
}

const ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const STATUSES = ["OPEN", "MITIGATING", "MONITORING", "CLOSED"];

export default function RisksPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["risks"], queryFn: () => api.get<Risk[]>("/risks") });
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/risks/${id}`, { status }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["risks"] }), qc.invalidateQueries({ queryKey: ["projects"] })]),
  });

  const all = data ?? [];
  const open = all.filter((r) => r.status !== "CLOSED");
  const rows = (showClosed ? all : open).slice().sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));

  return (
    <AppShell crumb="Risks & Issues">
      <div className="page-head">
        <div>
          <div className="page-title">Risks &amp; Issues</div>
          <div className="page-sub">{open.length} open risks · project-health auto-scoring based on these</div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => setShowClosed((s) => !s)}>
            {showClosed ? "Hide closed" : `Show closed (${all.length - open.length})`}
          </button>
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + Risk
          </button>
        </div>
      </div>
      {isLoading && <div className="empty">Loading…</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Risk</th>
              <th>Project</th>
              <th>Severity</th>
              <th>Owner</th>
              <th>Impact</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No open risks. Raise one with + Risk — event-day incidents rated High or Critical land here automatically.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="rowhover" onClick={() => router.push(`/projects/${r.project.id}?tab=risks`)}>
                <td>{r.title}</td>
                <td>{r.project.name}</td>
                <td>
                  <Pill value={r.severity} />
                </td>
                <td>{r.owner.name}</td>
                <td>{r.impact ?? "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select className="inp btn-sm" value={r.status} onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value })}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {title(s)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <NewRiskModal onClose={() => setAdding(false)} />}
    </AppShell>
  );
}
