"use client";

import { initials } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/AppShell";
import { FormField, Modal } from "../../components/GovernanceUi";
import { PersonSelect, ProjectSelect, useDirectory } from "../../components/OpsUi";
import { api } from "../../lib/api";

interface ActionItem {
  id: string;
  text: string;
  ownerId: string;
  ownerName: string;
  promotedTaskId: string | null;
}

interface Meeting {
  id: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  meetLink: string | null;
  notes: string | null;
  project: { id: string; name: string } | null;
  actionItems: ActionItem[];
}

interface GoogleStatus {
  mode: "disabled" | "sandbox" | "live";
  connected: boolean;
}

/** A Google Calendar "add event" link — works for anyone, no API key needed. */
function gcalLink(m: Meeting): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = new Date(m.startsAt);
  const end = new Date(start.getTime() + m.durationMinutes * 60_000);
  const details = [m.project ? `Project: ${m.project.name}` : "", m.meetLink ? `Google Meet: ${m.meetLink}` : "", m.notes ?? ""].filter(Boolean).join("\n");
  const q = new URLSearchParams({ action: "TEMPLATE", text: m.title, dates: `${fmt(start)}/${fmt(end)}`, details, ctz: "Asia/Kolkata" });
  if (m.meetLink) q.set("location", m.meetLink);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export default function MeetingsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["meetings"], queryFn: () => api.get<Meeting[]>("/meetings"), staleTime: 30_000 });
  const [scheduling, setScheduling] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Calendar links here with ?id=<meeting>; read once on mount (see letters page).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setOpenId(id);
  }, []);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000); // keeps "Live now / starts in" current
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const endOf = (m: Meeting) => new Date(m.startsAt).getTime() + m.durationMinutes * 60_000;
  const upcoming = (data ?? []).filter((m) => endOf(m) >= now);
  const earlier = (data ?? []).filter((m) => endOf(m) < now).reverse();
  const open = data?.find((m) => m.id === openId) ?? null;

  const row = (m: Meeting) => {
    const d = new Date(m.startsAt);
    const live = now >= d.getTime() && now <= endOf(m);
    const soon = !live && d.getTime() > now && d.getTime() - now < 60 * 60_000;
    return (
      <div key={m.id} className="meetrow">
        <div className="when">
          <div className="d">{d.getDate()}</div>
          <div className="m">
            {d.toLocaleDateString("en-IN", { month: "short" })} · {d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
        <div className="mmain">
          <div style={{ fontWeight: 600 }}>
            {m.title} {live && <span className="meet-live">Live now</span>}
            {soon && <span className="pill amber">Starts in {Math.round((d.getTime() - now) / 60_000)} min</span>}
          </div>
          <div className="small muted" style={{ margin: "2px 0 6px" }}>
            {m.project?.name ?? "Company meeting"} · {m.durationMinutes} min · {m.actionItems.length} action item{m.actionItems.length === 1 ? "" : "s"}
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            {m.actionItems.length > 0 && (
              <div className="avatars-stack">
                {[...new Map(m.actionItems.map((a) => [a.ownerId, a.ownerName])).values()].map((n) => (
                  <div key={n} className="av" title={n}>
                    {initials(n)}
                  </div>
                ))}
              </div>
            )}
            {m.meetLink ? <span className="meetchip">▶ {m.meetLink.replace("https://", "")}</span> : <span className="small faint">No Meet link</span>}
          </div>
        </div>
        <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
          {m.meetLink && (
            <a className="btn-primary btn-sm" href={m.meetLink} target="_blank" rel="noreferrer">
              Join Google Meet
            </a>
          )}
          <a className="btn-ghost btn-sm" href={gcalLink(m)} target="_blank" rel="noreferrer">
            Add to Calendar
          </a>
          <button className="btn-ghost btn-sm" onClick={() => setOpenId(m.id)}>
            Notes &amp; actions
          </button>
        </div>
      </div>
    );
  };

  return (
    <AppShell crumb="Meetings">
      <div className="page-head">
        <div>
          <div className="page-title">Meetings</div>
          <div className="page-sub">Every meeting gets a Google Meet link, goes on the calendar, and turns its action items into tasks</div>
        </div>
        <div className="page-actions">
          <a className="btn-ghost" href="https://meet.google.com/new" target="_blank" rel="noreferrer">
            Start instant Meet
          </a>
          <button className="btn-primary" onClick={() => setScheduling(true)}>
            + Schedule meeting
          </button>
        </div>
      </div>
      {error && <div className="notice red">{(error as Error).message}</div>}
      {isLoading && <div className="empty">Loading…</div>}
      <div className="section-block">
        <div className="panel-title">Upcoming</div>
        {!isLoading && upcoming.length === 0 && <div className="empty">No upcoming meetings. Schedule one — it shows on the Calendar, Home and everyone&apos;s My Work.</div>}
        {upcoming.map(row)}
      </div>
      {earlier.length > 0 && (
        <div>
          <div className="panel-title">Earlier</div>
          {earlier.map(row)}
        </div>
      )}
      {scheduling && <ScheduleMeeting onClose={() => setScheduling(false)} />}
      {open && <MeetingNotes meeting={open} onClose={() => setOpenId(null)} />}
    </AppShell>
  );
}

function ScheduleMeeting({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: google } = useQuery({ queryKey: ["google-status"], queryFn: () => api.get<GoogleStatus>("/integrations/google/status"), staleTime: 5 * 60_000 });
  const canCreateMeet = google?.mode === "live" && google.connected;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ title: "", projectId: "", date: tomorrow, time: "16:00", duration: "45", meet: "auto", link: "", notes: "" });
  const save = useMutation({
    mutationFn: () =>
      api.post("/meetings", {
        title: f.title.trim(),
        startsAt: new Date(`${f.date}T${f.time}:00+05:30`).toISOString(),
        durationMinutes: Number(f.duration),
        projectId: f.projectId || null,
        notes: f.notes.trim() || null,
        ...(f.meet === "auto" && canCreateMeet ? { createMeetLink: true } : {}),
        ...(f.meet === "paste" && f.link.trim() ? { meetLink: f.link.trim() } : {}),
      }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["meetings"] }), qc.invalidateQueries({ queryKey: ["calendar"] }), qc.invalidateQueries({ queryKey: ["my-work"] })]);
      onClose();
    },
  });
  return (
    <Modal
      title="Schedule meeting"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!f.title.trim() || !f.date || !f.time || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Scheduling…" : "Schedule"}
          </button>
        </>
      }
    >
      <FormField label="Title">
        <input className="inp" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Menu tasting debrief" />
      </FormField>
      <FormField label="Project (optional)">
        <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} />
      </FormField>
      <div className="grid g3" style={{ gap: 10 }}>
        <FormField label="Date">
          <input className="inp" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </FormField>
        <FormField label="Time (IST)">
          <input className="inp" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        </FormField>
        <FormField label="Length">
          <select className="inp" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })}>
            {["15", "30", "45", "60", "90", "120"].map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Google Meet">
        <select className="inp" value={f.meet} onChange={(e) => setF({ ...f, meet: e.target.value })}>
          {canCreateMeet && <option value="auto">Create a Meet link on my Google Calendar</option>}
          <option value="paste">Paste a Meet link</option>
          <option value="none">No video call</option>
        </select>
      </FormField>
      {(f.meet === "paste" || (f.meet === "auto" && !canCreateMeet)) && (
        <FormField label="Meet link">
          <input className="inp" value={f.link} onChange={(e) => setF({ ...f, meet: "paste", link: e.target.value })} placeholder="https://meet.google.com/abc-defg-hij" />
          <span className="small muted">
            Open{" "}
            <a href="https://meet.google.com/new" target="_blank" rel="noreferrer">
              meet.google.com/new
            </a>
            , copy the link it gives you, and paste it here.
            {!canCreateMeet && " (Podium creates links itself once Google is connected on the Mail screen.)"}
          </span>
        </FormField>
      )}
      <FormField label="Agenda (optional)">
        <textarea className="inp" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </FormField>
      {save.error && <div className="notice red">{(save.error as Error).message}</div>}
    </Modal>
  );
}

function MeetingNotes({ meeting: m, onClose }: { meeting: Meeting; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: people } = useDirectory();
  const [notes, setNotes] = useState(m.notes ?? "");
  const [item, setItem] = useState({ text: "", ownerId: "" });
  const [projectFor, setProjectFor] = useState("");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["meetings"] }), qc.invalidateQueries({ queryKey: ["calendar"] })]);
  const saveNotes = useMutation({ mutationFn: () => api.patch(`/meetings/${m.id}`, { notes }), onSuccess: refresh });
  const addItem = useMutation({
    mutationFn: () => api.post(`/meetings/${m.id}/action-items`, item),
    onSuccess: () => {
      setItem({ text: "", ownerId: "" });
      return refresh();
    },
  });
  const promote = useMutation({
    mutationFn: (id: string) => api.post(`/meeting-action-items/${id}/promote`, m.project ? {} : { projectId: projectFor }),
    onSuccess: () => Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["tasks"] }), qc.invalidateQueries({ queryKey: ["my-work"] })]),
  });
  const cancel = useMutation({
    mutationFn: () => api.delete(`/meetings/${m.id}`),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const err = (saveNotes.error || addItem.error || promote.error || cancel.error) as Error | null;

  return (
    <Modal
      title={m.title}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn-ghost"
            style={{ marginRight: "auto", color: "var(--red)" }}
            disabled={cancel.isPending}
            onClick={() => window.confirm("Cancel this meeting? It will disappear from everyone's calendar in Podium.") && cancel.mutate()}
          >
            Cancel meeting
          </button>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary" disabled={saveNotes.isPending || notes === (m.notes ?? "")} onClick={() => saveNotes.mutate()}>
            {saveNotes.isPending ? "Saving…" : "Save notes"}
          </button>
        </>
      }
    >
      <div className="small muted">
        {new Date(m.startsAt).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })} · {m.durationMinutes} min · {m.project?.name ?? "Company meeting"}
      </div>
      <FormField label="Notes">
        <textarea className="inp" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Decisions, numbers agreed, follow-ups…" />
      </FormField>
      <div>
        <div className="small muted" style={{ fontWeight: 500, marginBottom: 4 }}>
          Action items
        </div>
        {m.actionItems.length === 0 && <div className="small faint">None yet.</div>}
        {m.actionItems.map((a) => (
          <div key={a.id} className="checkitem">
            <span style={{ flex: 1 }}>
              {a.text} <span className="small muted">· {a.ownerName}</span>
            </span>
            {a.promotedTaskId ? (
              <span className="pill green">Task created</span>
            ) : (
              <button className="btn-ghost btn-sm" disabled={promote.isPending || (!m.project && !projectFor)} onClick={() => promote.mutate(a.id)} title={!m.project && !projectFor ? "Choose a project below first" : ""}>
                → Task
              </button>
            )}
          </div>
        ))}
        {!m.project && m.actionItems.some((a) => !a.promotedTaskId) && (
          <div style={{ marginTop: 6 }}>
            <span className="small muted">Tasks from this meeting go to:</span>
            <ProjectSelect value={projectFor} onChange={setProjectFor} />
          </div>
        )}
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <input className="inp" style={{ flex: 1, minWidth: 0 }} placeholder="New action item" value={item.text} onChange={(e) => setItem({ ...item, text: e.target.value })} />
          <PersonSelect value={item.ownerId} onChange={(v) => setItem({ ...item, ownerId: v })} people={people} placeholder="Owner" />
          <button className="btn-primary btn-sm" disabled={!item.text.trim() || !item.ownerId || addItem.isPending} onClick={() => addItem.mutate()}>
            Add
          </button>
        </div>
      </div>
      {err && <div className="notice red">{err.message}</div>}
    </Modal>
  );
}
