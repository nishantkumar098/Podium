"use client";

import { daysTo, fmtDate, fmtINR } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { HealthDot, NewProjectModal, Pill, title } from "../../components/OpsUi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";

interface Home {
  monthLabel: string;
  stats: {
    activeProjects: number;
    atRisk: number;
    onTrack: number;
    /** null when the viewer may not see money — the tile is left out rather than shown as zero. */
    bookedRevenue: number | null;
    collected: number | null;
    receivables: number | null;
    openInvoices: number | null;
    pipelineValue: number | null;
    openDeals: number | null;
  };
  cities: Array<{ id: string; name: string; isHq: boolean; revenue: number | null; netPct: number | null; lowStock: number | null; overdue: number | null }>;
  queue: Array<{ id: string; name: string; status: string; flowId: string; flow: string; dueAt: string | null }>;
  waiting: Array<{ id: string; name: string; flow: string; on: string[] }>;
  flows: Array<{ id: string; name: string; done: number; total: number; blocked: boolean }> | null;
  projects: Array<{ id: string; name: string; type: string; city: string; eventDate: string; eventDateText: string | null; pm: string; status: string; health: string; progress: number | null }>;
  approvals: Array<{ id: string; title: string; type: string; project: { id: string; name: string } | null }> | null;
  risks: Array<{ id: string; title: string; severity: string; owner: string; project: { id: string; name: string } }> | null;
  meetings: Array<{ id: string; title: string; startsAt: string; meetLink: string | null }>;
  announcements: Array<{ id: string; text: string; at: string; by: string }>;
  canPostAnnouncement: boolean;
  activity: Array<{ id: string; who: string; text: string; at: string }>;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days} d ago` : fmtDate(iso);
}

const inr = (n: number | null) => (n === null ? "—" : fmtINR(n));

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: h, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Home>("/dashboard"), staleTime: 60_000 });
  const [creating, setCreating] = useState(false);
  const [posting, setPosting] = useState(false);

  const first = user?.name.split(" ")[0] ?? "";
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <AppShell crumb="Home">
      <div className="page-head">
        <div>
          <div className="page-title">
            {greeting()}
            {first ? `, ${first}` : ""}
          </div>
          <div className="page-sub">
            {today} · Podium control tower — AMM Brands LLP · {h ? `${h.cities.length} cities` : "six cities"}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" onClick={() => router.push("/analytics")}>
            View Reports
          </button>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New Project
          </button>
        </div>
      </div>

      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading the control tower…</div>}

      {h && (
        <>
          {/* ---------------------------------------------------- headline */}
          <div className="grid g4 section-block">
            <div className="stat" style={{ borderLeftColor: "var(--brass)" }}>
              <div className="k">Active Projects</div>
              <div className="v">{h.stats.activeProjects}</div>
              <div className="d">
                {h.stats.atRisk} at risk · {h.stats.onTrack} on track
              </div>
            </div>
            {h.stats.bookedRevenue !== null && (
              <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
                <div className="k">Revenue (Live Projects)</div>
                <div className="v">{fmtINR(h.stats.bookedRevenue)}</div>
                {h.stats.collected !== null && <div className="d up">↑ {fmtINR(h.stats.collected)} collected</div>}
              </div>
            )}
            {h.stats.receivables !== null && (
              <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
                <div className="k">Receivables Outstanding</div>
                <div className="v">{fmtINR(h.stats.receivables)}</div>
                <div className="d down">
                  across {h.stats.openInvoices} open invoice{h.stats.openInvoices === 1 ? "" : "s"}
                </div>
              </div>
            )}
            {h.stats.pipelineValue !== null && (
              <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
                <div className="k">Sales Pipeline</div>
                <div className="v">{fmtINR(h.stats.pipelineValue)}</div>
                <div className="d">{h.stats.openDeals} open deals</div>
              </div>
            )}
          </div>

          {/* --------------------------------------------------- city strip */}
          <div className="section-block">
            <div className="panel-title">
              {h.cities.length} cities · {h.monthLabel}
            </div>
            <div className="citystrip">
              {h.cities.map((c) => (
                <button key={c.id} className="cityc" onClick={() => router.push("/reports")}>
                  <div className="cn">
                    {c.name}
                    {c.isHq && <span className="small faint">HQ</span>}
                  </div>
                  <div className="cv">{inr(c.revenue)}</div>
                  <div className={`cm ${c.netPct !== null && c.netPct < 0 ? "negative" : ""}`}>{c.netPct === null ? "no invoiced revenue yet" : `net ${c.netPct.toFixed(1)}%`}</div>
                  <div className="cm">
                    {c.lowStock === null ? null : c.lowStock > 0 ? <span className="negative">{c.lowStock} low stock</span> : "stock ok"}
                    {c.overdue ? (
                      <>
                        {" · "}
                        <span className="negative">{c.overdue} overdue</span>
                      </>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* ------------------------------------ queue / meetings / news */}
          <div className="grid g2 section-block">
            <div className="panel">
              <div className="panel-title">
                Up next for you <Link href="/flows">All flows →</Link>
              </div>
              {h.queue.length === 0 && <div className="small muted">Nothing waiting on you. Flow steps assigned to you appear here when they are ready.</div>}
              {h.queue.map((s) => {
                const late = s.dueAt && new Date(s.dueAt).getTime() < Date.now();
                return (
                  <div key={s.id} className="row small" style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", cursor: "pointer" }} onClick={() => router.push("/flows")}>
                    <span style={{ flex: 1 }}>
                      <b style={{ fontWeight: 500 }}>{s.name}</b> <span className="muted">· {s.flow}</span>
                    </span>
                    {s.dueAt && <span className={late ? "negative" : "muted"}>{late ? "overdue" : `due ${fmtDate(s.dueAt)}`}</span>}
                    <Pill value={s.status} />
                  </div>
                );
              })}
              {h.waiting.length > 0 && (
                <>
                  <div className="panel-title" style={{ marginTop: 16 }}>
                    Lined up for you next
                  </div>
                  {h.waiting.map((w) => (
                    <div key={w.id} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5" }}>
                      <span style={{ flex: 1 }}>
                        <b style={{ fontWeight: 500 }}>{w.name}</b> <span className="muted">· {w.flow}</span>
                      </span>
                      <span className="muted">waiting on {w.on.map((n) => n.split(" ")[0]).join(" & ")}</span>
                    </div>
                  ))}
                </>
              )}
              {h.flows !== null && (
                <>
                  <div className="panel-title" style={{ marginTop: 16 }}>
                    Flows in motion
                  </div>
                  {h.flows.length === 0 && <div className="small muted">No flows running.</div>}
                  {h.flows.map((f) => (
                    <div key={f.id} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5", cursor: "pointer" }} onClick={() => router.push("/flows")}>
                      <span style={{ flex: 1 }}>{f.name}</span>
                      <span className="segbar" style={{ width: 110 }}>
                        {Array.from({ length: f.total }, (_, i) => (
                          <span key={i} className={i < f.done ? "on" : ""} />
                        ))}
                      </span>
                      <span className={`pill ${f.blocked ? "red" : "blue"}`}>{f.blocked ? "Blocked" : `${f.done}/${f.total} done`}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel">
                <div className="panel-title">Today&apos;s meetings</div>
                {h.meetings.length === 0 && <div className="small muted">No meetings today.</div>}
                {h.meetings.map((m) => (
                  <div key={m.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12 }}>
                    <span className="mono small" style={{ width: 62 }}>
                      {new Date(m.startsAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span style={{ flex: 1 }}>{m.title}</span>
                    {m.meetLink && (
                      <a className="btn-ghost btn-sm" href={m.meetLink} target="_blank" rel="noreferrer">
                        Join
                      </a>
                    )}
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-title">
                  Announcements{" "}
                  {h.canPostAnnouncement && (
                    <button className="btn-ghost btn-sm" onClick={() => setPosting(true)}>
                      + Post
                    </button>
                  )}
                </div>
                {h.announcements.length === 0 && <div className="small muted">No announcements yet.</div>}
                {h.announcements.map((a) => (
                  <div key={a.id} className="activity-item">
                    <div className="dot2" />
                    <div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{a.text}</div>
                      <div className="when">
                        {a.by} · {timeAgo(a.at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ------------------------------ health / approvals / risks */}
          <div className="grid g2 section-block">
            <div className="panel">
              <div className="panel-title">
                Project Health <Link href="/projects">View all →</Link>
              </div>
              {h.projects.length === 0 && <div className="empty">No upcoming projects.</div>}
              <div className="plist">
                {h.projects.map((p) => (
                  <div key={p.id} className="pcard" onClick={() => router.push(`/projects/${p.id}`)}>
                    <HealthDot health={p.health} />
                    <div className="pbar">
                      <div className="pname">{p.name}</div>
                      <div className="pmeta">
                        {p.type} · {p.city} · {p.eventDateText || fmtDate(p.eventDate)} ({daysTo(p.eventDate)}d) · PM {p.pm}
                      </div>
                    </div>
                    <div className="pright">
                      <div className="progress">
                        <div style={{ width: `${p.progress ?? 0}%` }} />
                      </div>
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }} title={p.progress === null ? "No tasks yet" : undefined}>
                        {p.progress === null ? "—" : `${p.progress}%`}
                      </div>
                      <Pill value={p.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {h.approvals !== null && (
                <div className="panel">
                  <div className="panel-title">
                    Pending Approvals <Link href="/approvals">All →</Link>
                  </div>
                  {h.approvals.length === 0 && <div className="small muted">Nothing waiting for approval.</div>}
                  {h.approvals.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12 }}>
                      <div>
                        <div style={{ fontWeight: 500, color: "var(--text)" }}>{a.title}</div>
                        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{a.project?.name ?? "No project"}</div>
                      </div>
                      <span className="pill amber">{title(a.type)}</span>
                    </div>
                  ))}
                </div>
              )}
              {h.risks !== null && (
                <div className="panel">
                  <div className="panel-title">
                    Critical Risks <Link href="/risks">All →</Link>
                  </div>
                  {h.risks.length === 0 && <div className="small muted">No open risks.</div>}
                  {h.risks.map((r) => (
                    <div key={r.id} style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12, cursor: "pointer" }} onClick={() => router.push(`/projects/${r.project.id}?tab=risks`)}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontWeight: 500 }}>{r.title}</span>
                        <Pill value={r.severity} />
                      </div>
                      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>
                        {r.project.name} · Owner: {r.owner}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* --------------------------------------- upcoming / activity */}
          <div className="grid g2">
            <div className="panel">
              <div className="panel-title">Upcoming Events</div>
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Date</th>
                    <th>Days Out</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {h.projects.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No upcoming events.
                      </td>
                    </tr>
                  )}
                  {h.projects.slice(0, 5).map((p) => (
                    <tr key={p.id} className="rowhover" onClick={() => router.push(`/projects/${p.id}`)}>
                      <td>{p.name}</td>
                      <td className="mono">{fmtDate(p.eventDate)}</td>
                      <td className="mono">{daysTo(p.eventDate)}</td>
                      <td>
                        <Pill value={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-title">Recent Activity</div>
              {h.activity.length === 0 && <div className="small muted">Nothing recorded yet.</div>}
              {h.activity.map((a) => (
                <div key={a.id} className="activity-item">
                  <div className="dot2" />
                  <div>
                    <div>
                      <b>{a.who}</b> {a.text}
                    </div>
                    <div className="when">{timeAgo(a.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {creating && <NewProjectModal onClose={() => setCreating(false)} onCreated={(id) => router.push(`/projects/${id}`)} />}
      {posting && <PostAnnouncement onClose={() => setPosting(false)} />}
    </AppShell>
  );
}

function PostAnnouncement({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const post = useMutation({
    mutationFn: () => api.post("/dashboard/announcements", { text: text.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });
  return (
    <Modal
      title="Post announcement"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!text.trim() || post.isPending} onClick={() => post.mutate()}>
            {post.isPending ? "Posting…" : "Post to everyone"}
          </button>
        </>
      }
    >
      <FormField label="Announcement">
        <textarea className="inp" rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Visible to everyone on Home and in #announcements" />
      </FormField>
      {post.error && <div className="notice red">{(post.error as Error).message}</div>}
    </Modal>
  );
}
