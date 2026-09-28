"use client";

import { daysTo, fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { AddCueForm, CreateRunsheetForm } from "../../components/EventDayPanel";
import { Avatar } from "../../components/GovernanceUi";
import { Pill, title, upcomingOnly, useProjects } from "../../components/OpsUi";
import { api, ApiError } from "../../lib/api";
import type { CheckinDto, IncidentDto, RunsheetDto } from "../../lib/types";

interface Crew {
  id: string;
  name: string;
  role: string;
}

interface ProjectCrew {
  id: string;
  name: string;
  eventDate: string;
  city: { name: string };
  pm: { id: string; name: string };
  members: Array<{ roleOnProject: string; user: { id: string; name: string; primaryRole: { name: string } | null } }>;
}

/**
 * Event day: run-of-show, crew check-in and incident log for one event —
 * laid out for a phone at the venue. Every figure is read from the project's
 * runsheet, check-ins and incidents; nothing here is sample data.
 */
export default function EventDayPage() {
  const qc = useQueryClient();
  const { data: projects, isLoading } = useProjects();
  const upcoming = useMemo(() => upcomingOnly(projects), [projects]);
  const [pid, setPid] = useState("");
  useEffect(() => {
    if (!pid && upcoming[0]) setPid(upcoming[0].id);
  }, [pid, upcoming]);

  const project = useQuery({ queryKey: ["project", pid], queryFn: () => api.get<ProjectCrew>(`/projects/${pid}`), enabled: !!pid });
  const runsheet = useQuery({ queryKey: ["runsheet", pid], queryFn: () => api.get<RunsheetDto>(`/projects/${pid}/runsheet`), enabled: !!pid });
  const checkins = useQuery({ queryKey: ["checkins", pid], queryFn: () => api.get<CheckinDto[]>(`/projects/${pid}/checkins`), enabled: !!pid });
  const incidents = useQuery({ queryKey: ["incidents", pid], queryFn: () => api.get<IncidentDto[]>(`/projects/${pid}/incidents`), enabled: !!pid });
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api.get<Array<{ id: string; name: string; projectId: string | null }>>("/channels") });

  const [error, setError] = useState<string | null>(null);
  const onError = (e: ApiError) => setError(e.message);
  const refresh = (key: string) => qc.invalidateQueries({ queryKey: [key, pid] });

  const p = project.data;
  const crew: Crew[] = useMemo(() => {
    if (!p) return [];
    const list: Crew[] = [{ id: p.pm.id, name: p.pm.name, role: "Project Manager" }];
    for (const m of p.members) if (!list.some((c) => c.id === m.user.id)) list.push({ id: m.user.id, name: m.user.name, role: m.user.primaryRole?.name ?? title(m.roleOnProject) });
    return list;
  }, [p]);

  const items = runsheet.data?.items ?? [];
  const done = items.filter((i) => i.doneAt).length;
  const next = items.findIndex((i) => !i.doneAt);
  const checkedIn = new Set((checkins.data ?? []).map((c) => c.userId));
  const incidentList = incidents.data ?? [];
  const channel = channels.data?.find((c) => c.projectId === pid);
  const d = p ? daysTo(p.eventDate) : 0;

  const toggle = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api.patch(`/runsheet-items/${v.id}/done`, { done: v.done }),
    onSuccess: () => refresh("runsheet"),
    onError,
  });
  const checkIn = useMutation({ mutationFn: (userId: string) => api.post(`/projects/${pid}/checkins`, { userId }), onSuccess: () => refresh("checkins"), onError });
  const [sev, setSev] = useState("MEDIUM");
  const [text, setText] = useState("");
  const log = useMutation({
    mutationFn: () => api.post<{ escalated: boolean }>(`/projects/${pid}/incidents`, { severity: sev, text: text.trim() }),
    onSuccess: () => {
      setText("");
      refresh("incidents");
      qc.invalidateQueries({ queryKey: ["risks"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError,
  });
  const [bc, setBc] = useState("");
  const [sent, setSent] = useState(false);
  const broadcast = useMutation({
    mutationFn: () => api.post(`/channels/${channel!.id}/messages`, { body: `📣 ${bc.trim()}` }),
    onSuccess: () => {
      setBc("");
      setSent(true);
    },
    onError,
  });

  return (
    <AppShell crumb="Event day">
      <div className="page-head">
        <div>
          <div className="page-title">Event day</div>
          <div className="page-sub">The run-of-show, crew check-in and incident log for the day itself — built for a phone at the venue</div>
        </div>
        <div className="page-actions">
          <select className="inp" value={pid} onChange={(e) => { setPid(e.target.value); setError(null); setSent(false); }} aria-label="Event">
            {upcoming.length === 0 && <option value="">No upcoming events</option>}
            {upcoming.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {fmtDate(x.eventDate)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <div className="empty">Loading…</div>}
      {!isLoading && upcoming.length === 0 && <div className="empty">No upcoming events to run.</div>}
      {error && (
        <div className="notice red" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {p && (
        <>
          <div className="grid g4 section-block">
            <div className="stat">
              <div className="k">{d > 0 ? "Starts in" : "Status"}</div>
              <div className="v">{d > 0 ? `${d} days` : d === 0 ? "Live today" : "Finished"}</div>
              <div className="d">
                {fmtDate(p.eventDate)} · {p.city.name}
              </div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--green)" }}>
              <div className="k">Run-of-show</div>
              <div className="v">
                {done}/{items.length}
              </div>
              <div className="d">cues done</div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--blue)" }}>
              <div className="k">Crew checked in</div>
              <div className="v">
                {crew.filter((c) => checkedIn.has(c.id)).length}/{crew.length}
              </div>
            </div>
            <div className="stat" style={{ borderLeftColor: "var(--red)" }}>
              <div className="k">Incidents</div>
              <div className="v">{incidentList.length}</div>
              <div className="d">{incidentList.filter((i) => i.raisedRiskId).length} raised as risks</div>
            </div>
          </div>

          <div className="grid g-side-r">
            <div>
              {!runsheet.isLoading && !runsheet.data?.id && (
                <CreateRunsheetForm projectId={pid} people={crew} onDone={() => { setError(null); refresh("runsheet"); }} onError={onError} />
              )}
              {runsheet.data?.id && (
                <div className="panel">
                  <div className="panel-title">
                    Run-of-show {d > 0 && <span className="pill gray" style={{ textTransform: "none" }}>Rehearsal mode — tick cues to walk through it</span>}
                  </div>
                  {items.map((it, i) => {
                    const owner = crew.find((c) => c.id === it.ownerId)?.name ?? "—";
                    return (
                      <div key={it.id} className={`ros ${it.doneAt ? "done" : ""} ${i === next ? "next" : ""}`}>
                        <input type="checkbox" checked={!!it.doneAt} onChange={(e) => toggle.mutate({ id: it.id, done: e.target.checked })} aria-label={it.text} />
                        <span className="rt">{it.scheduledTime}</span>
                        <span className="rw" style={{ flex: 1 }}>
                          {it.text}
                        </span>
                        <Avatar name={owner} />
                        <span className="small muted">{owner.split(" ")[0]}</span>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 10 }}>
                    <AddCueForm runsheetId={runsheet.data.id} people={crew} onDone={() => refresh("runsheet")} onError={onError} />
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel">
                <div className="panel-title">Crew check-in</div>
                {crew.length === 1 && <div className="small muted" style={{ marginBottom: 6 }}>Only the PM is on this project — add crew on the project&apos;s Team tab.</div>}
                {crew.map((c) => {
                  const on = checkedIn.has(c.id);
                  return (
                    <label key={c.id} className="checkitem" style={{ cursor: on ? "default" : "pointer" }}>
                      <input type="checkbox" checked={on} disabled={on || checkIn.isPending} onChange={() => checkIn.mutate(c.id)} />
                      <span style={{ flex: 1 }}>{c.name}</span>
                      <span className="small faint">
                        {on ? `in ${new Date(checkins.data!.find((x) => x.userId === c.id)!.checkedInAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}` : c.role}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="panel">
                <div className="panel-title">Incidents</div>
                <div className="row" style={{ gap: 6 }}>
                  <select className="inp" value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity">
                    {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => (
                      <option key={s} value={s}>
                        {title(s)}
                      </option>
                    ))}
                  </select>
                  <input className="inp" style={{ flex: 1, minWidth: 0 }} placeholder="What happened?" value={text} onChange={(e) => setText(e.target.value)} aria-label="Incident" />
                  <button className="btn-primary btn-sm" disabled={!text.trim() || log.isPending} onClick={() => log.mutate()}>
                    Log
                  </button>
                </div>
                {incidentList.length === 0 && <div className="empty">No incidents. Log anything that affects guests, safety or stock.</div>}
                {incidentList.map((x) => (
                  <div key={x.id} className="activity-item">
                    <div className="dot2" style={{ background: "var(--red)" }} />
                    <div>
                      <div>
                        <Pill value={x.severity} /> {x.text}
                      </div>
                      <div className="when">
                        {x.reportedByName} · {new Date(x.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                        {x.raisedRiskId ? " · raised as a risk" : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {channel && (
                <div className="panel">
                  <div className="panel-title">Broadcast to crew</div>
                  <div className="row" style={{ gap: 6 }}>
                    <input className="inp" style={{ flex: 1, minWidth: 0 }} placeholder="e.g. Doors delayed 20 min" value={bc} onChange={(e) => { setBc(e.target.value); setSent(false); }} aria-label="Broadcast" />
                    <button className="btn-ghost btn-sm" disabled={!bc.trim() || broadcast.isPending} onClick={() => broadcast.mutate()}>
                      Send to #{channel.name}
                    </button>
                  </div>
                  {sent && <div className="small muted" style={{ marginTop: 6 }}>Sent.</div>}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
