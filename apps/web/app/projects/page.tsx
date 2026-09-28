"use client";

import { daysTo, fmtDate, fmtINR, initials } from "@podium/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { CityChips } from "../../components/GovernanceUi";
import { HealthDot, NewProjectModal, Pill, useProjects } from "../../components/OpsUi";

/**
 * Pending vs completed, by the project's own status — not by date — so a
 * finished job stays finished and an event still to run stays pending.
 */
const VIEWS = [
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
] as const;

const isDone = (status: string) => status === "COMPLETED" || status === "CANCELLED";

export default function ProjectsPage() {
  const router = useRouter();
  const { data, isLoading } = useProjects();
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("pending");
  const [cityId, setCityId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [creating, setCreating] = useState(false);

  const all = data ?? [];
  const pending = all.filter((p) => !isDone(p.status));
  const completed = all.filter((p) => p.status === "COMPLETED");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = all.filter(
      (p) =>
        (view === "all" || (view === "pending" ? !isDone(p.status) : isDone(p.status))) &&
        (!cityId || p.city.id === cityId) &&
        (!needle || `${p.name} ${p.client.name} ${p.type}`.toLowerCase().includes(needle)),
    );
    // Pending reads soonest-first; completed reads most-recent-first.
    return view === "completed" ? rows.slice().reverse() : rows;
  }, [all, view, cityId, q]);

  return (
    <AppShell crumb="Projects">
      <div className="page-head">
        <div>
          <div className="page-title">Projects</div>
          <div className="page-sub">
            {all.length} projects · {pending.length} pending · {completed.length} completed
          </div>
        </div>
        <div className="page-actions">
          <button className={showFilter ? "btn-primary" : "btn-ghost"} onClick={() => setShowFilter((s) => !s)}>
            Filter
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New Project
          </button>
        </div>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="chips">
          {VIEWS.map((v) => (
            <button key={v.key} className={`chipbtn ${view === v.key ? "on" : ""}`} onClick={() => setView(v.key)}>
              {v.label}
              {v.key !== "all" && ` (${v.key === "pending" ? pending.length : completed.length})`}
            </button>
          ))}
        </div>
        <input className="inp" style={{ flex: "1 1 220px", maxWidth: 320 }} placeholder="Search project, client or type" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {showFilter && (
        <div style={{ marginBottom: 12 }}>
          <CityChips value={cityId} onChange={setCityId} />
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && list.length === 0 && (
        <div className="empty">{view === "pending" ? "Nothing pending here — switch to Completed or All to see finished events." : "No projects match."}</div>
      )}
      <div className="plist">
        {list.map((p) => {
          const progress = p.tasks.total ? Math.round((p.tasks.done / p.tasks.total) * 100) : 0;
          const d = daysTo(p.eventDate);
          return (
            <div key={p.id} className="pcard" onClick={() => router.push(`/projects/${p.id}`)}>
              <HealthDot health={p.health} />
              <div className="pbar">
                <div className="pname">{p.name}</div>
                <div className="pmeta">
                  {p.type} · {p.city.name} · Client: {p.client.name} · PM {p.pm.name} · {p.eventDateText || fmtDate(p.eventDate)}
                  {d >= 0 ? ` · ${d === 0 ? "today" : `${d}d`}` : ""}
                </div>
              </div>
              <div className="pright">
                {/* The server omits revenue entirely for anyone without
                    budgets:view, so the figure is not shown as a dash — which
                    would read as zero — but left out with the reason. */}
                <div style={{ textAlign: "right" }}>
                  {p.revenue === undefined ? (
                    <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>revenue hidden</div>
                  ) : (
                    <>
                      <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                        {Number(p.revenue) > 0 ? fmtINR(Number(p.revenue)) : "—"}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>revenue</div>
                    </>
                  )}
                </div>
                <div className="avatars-stack">
                  {p.team.slice(0, 4).map((t) => (
                    <div key={t.id} className="av" title={t.name}>
                      {initials(t.name)}
                    </div>
                  ))}
                </div>
                <div title={p.tasks.total ? `${p.tasks.done}/${p.tasks.total} tasks done` : "No tasks yet"}>
                  <div className="progress">
                    <div style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <Pill value={p.status} />
              </div>
            </div>
          );
        })}
      </div>

      {creating && <NewProjectModal onClose={() => setCreating(false)} onCreated={(id) => router.push(`/projects/${id}`)} />}
    </AppShell>
  );
}
