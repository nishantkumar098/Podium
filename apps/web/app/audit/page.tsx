"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { Avatar } from "../../components/GovernanceUi";
import { api } from "../../lib/api";

interface Row {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId: string;
  who: string;
  actorId: string | null;
  text: string;
  ip: string | null;
}

interface Page {
  total: number;
  nextCursor: string | null;
  rows: Row[];
}

interface Filters {
  actions: Array<{ action: string; count: number }>;
  entityTypes: Array<{ entityType: string; count: number }>;
  actors: Array<{ id: string; name: string; count: number }>;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** Audit log — append-only, Founder and Admin only (enforced by the server). */
export default function AuditPage() {
  const [actorId, setActorId] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);

  const cursor = cursors[cursors.length - 1];
  const query = new URLSearchParams({
    ...(actorId ? { actorId } : {}),
    ...(entityType ? { entityType } : {}),
    ...(action ? { action } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00+05:30`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59+05:30`).toISOString() } : {}),
    ...(cursor ? { cursor } : {}),
  }).toString();

  const { data, isLoading, error } = useQuery({ queryKey: ["audit", query], queryFn: () => api.get<Page>(`/audit?${query}`) });
  const { data: filters } = useQuery({ queryKey: ["audit-filters"], queryFn: () => api.get<Filters>("/audit/filters"), retry: false });

  const reset = (fn: () => void) => {
    fn();
    setCursors([]);
  };

  const exportCsv = async () => {
    // Export what the filters select, not just the page on screen.
    const all = await api.get<Page>(`/audit?${new URLSearchParams(query).toString()}&limit=500`);
    const rows = [["Time", "Person", "Action", "What happened", "Entity", "Entity id"], ...all.rows.map((r) => [when(r.at), r.who, r.action, r.text, r.entityType, r.entityId])];
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `podium-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const isForbidden = (error as { status?: number } | null)?.status === 403;

  return (
    <AppShell crumb="Audit log">
      <div className="page-head">
        <div>
          <div className="page-title">Audit log</div>
          <div className="page-sub">
            Every change made in Podium — who did what, and when. Append-only: nothing here can be edited or deleted.
            {data ? ` · ${data.total.toLocaleString("en-IN")} entries match` : ""}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" disabled={!data?.rows.length} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="notice red">{isForbidden ? "Only the Founder or an Admin can read the audit log." : (error as Error).message}</div>}

      {!isForbidden && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <select className="inp" value={actorId} onChange={(e) => reset(() => setActorId(e.target.value))}>
              <option value="">Everyone</option>
              {filters?.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.count})
                </option>
              ))}
            </select>
            <select className="inp" value={entityType} onChange={(e) => reset(() => setEntityType(e.target.value))}>
              <option value="">Anything</option>
              {filters?.entityTypes.map((e2) => (
                <option key={e2.entityType} value={e2.entityType}>
                  {e2.entityType.replace(/_/g, " ")} ({e2.count})
                </option>
              ))}
            </select>
            <select className="inp" value={action} onChange={(e) => reset(() => setAction(e.target.value))} style={{ maxWidth: 240 }}>
              <option value="">Any action</option>
              {filters?.actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {a.action} ({a.count})
                </option>
              ))}
            </select>
            <label className="small row" style={{ gap: 6 }}>
              From
              <input className="inp" type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} />
            </label>
            <label className="small row" style={{ gap: 6 }}>
              To
              <input className="inp" type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} />
            </label>
            {(actorId || entityType || action || from || to) && (
              <button
                className="btn-ghost btn-sm"
                onClick={() =>
                  reset(() => {
                    setActorId("");
                    setEntityType("");
                    setAction("");
                    setFrom("");
                    setTo("");
                  })
                }
              >
                Clear
              </button>
            )}
          </div>

          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>Time</th>
                  <th style={{ width: 190 }}>Person</th>
                  <th>What happened</th>
                  <th style={{ width: 200 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && data?.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Nothing recorded for these filters.
                    </td>
                  </tr>
                )}
                {data?.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">{when(r.at)}</td>
                    <td>
                      <Avatar name={r.who} /> &nbsp;{r.who}
                    </td>
                    <td>{r.text}</td>
                    <td className="mono small faint">
                      {r.action}
                      <div>{r.entityType.replace(/_/g, " ")}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ marginTop: 12, gap: 10 }}>
            <button className="btn-ghost" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
              ← Newer
            </button>
            <span className="mono small">
              {data ? `${data.rows.length} shown` : ""}
              {cursors.length ? ` · page ${cursors.length + 1}` : ""}
            </span>
            <button className="btn-ghost" disabled={!data?.nextCursor} onClick={() => data?.nextCursor && setCursors([...cursors, data.nextCursor])}>
              Older →
            </button>
          </div>
        </>
      )}
    </AppShell>
  );
}
