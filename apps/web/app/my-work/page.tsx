"use client";

import { daysTo, fmtDate } from "@podium/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { Pill, title } from "../../components/OpsUi";
import { useAuth } from "../../lib/auth";
import { api } from "../../lib/api";

interface Ref {
  id: string;
  name: string;
}

interface Work {
  summary: { tasks: number; overdue: number; steps: number; approvals: number; risks: number };
  tasks: Array<{ id: string; name: string; status: string; priority: string; dueAt: string | null; project: Ref }>;
  steps: Array<{ id: string; name: string; status: string; flow: string; project: Ref; dueAt: string | null; late: boolean }>;
  approvals: Array<{ id: string; title: string; type: string; approverRef: string; createdAt: string; project: Ref | null }>;
  risks: Array<{ id: string; title: string; severity: string; status: string; project: Ref }>;
  cues: Array<{ id: string; text: string; time: string; project: Ref & { eventDate: string } }>;
  events: Array<{ id: string; name: string; type: string; eventDate: string; eventDateText: string | null; role: string; city: { name: string } }>;
  meetings: Array<{ id: string; title: string; startsAt: string; durationMinutes: number; meetLink: string | null; project: Ref | null }>;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function MyWorkPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: w, isLoading, error } = useQuery({ queryKey: ["my-work"], queryFn: () => api.get<Work>("/me/work"), staleTime: 60_000 });

  return (
    <AppShell crumb="My Work">
      <div className="page-head">
        <div>
          <div className="page-title">My work</div>
          <div className="page-sub">
            {user?.name} · {user?.roles[0]} — flow steps handed to you, your tasks, approvals and the events you&apos;re on
          </div>
        </div>
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading your work…</div>}

      {w && (
        <>
          <div className="grid g4 section-block">
            <div className="stat" style={{ borderLeftColor: "var(--brass)" }}>
              <div className="k">Open tasks</div>
              <div className="v">{w.summary.tasks}</div>
              <div className={`d ${w.summary.overdue ? "down" : ""}`}>{w.summary.overdue} overdue</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
              <div className="k">Flow steps on you</div>
              <div className="v">{w.summary.steps}</div>
              <div className="d">{w.steps.filter((s) => s.late).length} past their SLA</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
              <div className="k">Approvals to decide</div>
              <div className="v">{w.summary.approvals}</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
              <div className="k">Risks you own</div>
              <div className="v">{w.summary.risks}</div>
            </div>
          </div>

          <div className="grid g2 section-block">
            <div className="panel">
              <div className="panel-title">
                Handed to you <Link href="/flows">All flows →</Link>
              </div>
              {w.steps.length === 0 && <div className="empty">No flow steps waiting on you.</div>}
              {w.steps.map((s) => (
                <div key={s.id} className="row small" style={{ padding: "8px 0", borderBottom: "1px solid #F1EEE5", cursor: "pointer" }} onClick={() => router.push("/flows")}>
                  <span style={{ flex: 1 }}>
                    <b style={{ fontWeight: 500 }}>{s.name}</b>
                    <div className="muted">
                      {s.flow} · {s.project.name}
                    </div>
                  </span>
                  {s.dueAt && <span className={s.late ? "negative" : "muted"}>{s.late ? "past SLA" : `due ${fmtDate(s.dueAt)}`}</span>}
                  <Pill value={s.status} />
                </div>
              ))}
            </div>
            <div className="panel">
              <div className="panel-title">
                Approvals waiting for you <Link href="/approvals">All →</Link>
              </div>
              {w.approvals.length === 0 && <div className="empty">Nothing for you to approve.</div>}
              {w.approvals.map((a) => (
                <div key={a.id} className="row small" style={{ padding: "8px 0", borderBottom: "1px solid #F1EEE5", cursor: "pointer" }} onClick={() => router.push("/approvals")}>
                  <span style={{ flex: 1 }}>
                    <b style={{ fontWeight: 500 }}>{a.title}</b>
                    <div className="muted">
                      {a.project?.name ?? "No project"} · raised {fmtDate(a.createdAt)}
                    </div>
                  </span>
                  <span className="pill amber">{title(a.type)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel section-block">
            <div className="panel-title">
              Your tasks <Link href="/tasks">Board →</Link>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Project</th>
                  <th>Priority</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {w.tasks.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      No open tasks assigned to you.
                    </td>
                  </tr>
                )}
                {w.tasks.map((t) => (
                  <tr key={t.id} className="rowhover" onClick={() => router.push(`/projects/${t.project.id}?tab=tasks`)}>
                    <td>{t.name}</td>
                    <td>{t.project.name}</td>
                    <td>
                      <Pill value={t.priority} />
                    </td>
                    <td className={`mono ${t.dueAt && daysTo(t.dueAt) < 0 ? "negative" : ""}`}>{t.dueAt ? fmtDate(t.dueAt) : "—"}</td>
                    <td>
                      <Pill value={t.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid g2 section-block">
            <div className="panel">
              <div className="panel-title">
                Your events <Link href="/projects">Projects →</Link>
              </div>
              {w.events.length === 0 && <div className="empty">You aren&apos;t on any upcoming event.</div>}
              {w.events.map((e) => (
                <div key={e.id} className="row small" style={{ padding: "8px 0", borderBottom: "1px solid #F1EEE5", cursor: "pointer" }} onClick={() => router.push(`/projects/${e.id}`)}>
                  <span style={{ flex: 1 }}>
                    <b style={{ fontWeight: 500 }}>{e.name}</b>
                    <div className="muted">
                      {e.type} · {e.city.name} · {e.eventDateText || fmtDate(e.eventDate)}
                    </div>
                  </span>
                  <span className="mono muted">{daysTo(e.eventDate)}d</span>
                  <span className={`pill ${e.role === "Project Manager" ? "blue" : "gray"}`}>{e.role}</span>
                </div>
              ))}
            </div>
            <div className="panel">
              <div className="panel-title">
                Your meetings this week <Link href="/meetings">All →</Link>
              </div>
              {w.meetings.length === 0 && <div className="empty">No meetings coming up.</div>}
              {w.meetings.map((m) => (
                <div key={m.id} className="row" style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12 }}>
                  <span className="mono small" style={{ width: 130 }}>
                    {when(m.startsAt)}
                  </span>
                  <span style={{ flex: 1 }}>
                    {m.title}
                    {m.project && <span className="muted"> · {m.project.name}</span>}
                  </span>
                  {m.meetLink && (
                    <a className="btn-ghost btn-sm" href={m.meetLink} target="_blank" rel="noreferrer">
                      Join Meet
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>

          {(w.risks.length > 0 || w.cues.length > 0) && (
            <div className="grid g2">
              <div className="panel">
                <div className="panel-title">Risks you own</div>
                {w.risks.length === 0 && <div className="empty">None.</div>}
                {w.risks.map((r) => (
                  <div key={r.id} style={{ padding: "7px 0", borderBottom: "1px solid #F1EEE5", fontSize: 12, cursor: "pointer" }} onClick={() => router.push(`/projects/${r.project.id}?tab=risks`)}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 500 }}>{r.title}</span>
                      <Pill value={r.severity} />
                    </div>
                    <div className="small muted">
                      {r.project.name} · {title(r.status)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-title">
                  Your run-of-show cues <Link href="/event-day">Event day →</Link>
                </div>
                {w.cues.length === 0 && <div className="empty">No cues assigned to you this week.</div>}
                {w.cues.map((c) => (
                  <div key={c.id} className="ros">
                    <span className="rt">{c.time}</span>
                    <span className="rw" style={{ flex: 1 }}>
                      {c.text}
                    </span>
                    <span className="small muted">
                      {c.project.name} · {fmtDate(c.project.eventDate)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
