"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StatusPill } from "./StatusPill";
import type { CheckinDto, IncidentDto, RunsheetDto } from "../lib/types";

interface Person { id: string; name: string }

const SUB_TABS = ["runsheet", "checkins", "incidents"] as const;

/**
 * Event Day (blueprint §20): run-of-show checklist, crew check-in, incident
 * log. There is no "list users" endpoint in this workspace, so the people
 * picker here is deliberately the project's own roster (PM + members) passed
 * in from the project detail page — event-day operations are inherently
 * project-scoped, so this is the correct source, not a workaround.
 */
export function EventDayPanel({ projectId, people }: { projectId: string; people: Person[] }) {
  const [sub, setSub] = useState<(typeof SUB_TABS)[number]>("runsheet");
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "Unknown";

  return (
    <div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        {SUB_TABS.map((t) => (
          <button key={t} className={`tab ${sub === t ? "active" : ""}`} onClick={() => setSub(t)}>
            {t === "checkins" ? "Check-ins" : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {sub === "runsheet" && <RunsheetTab projectId={projectId} people={people} nameOf={nameOf} />}
      {sub === "checkins" && <CheckinsTab projectId={projectId} people={people} />}
      {sub === "incidents" && <IncidentsTab projectId={projectId} />}
    </div>
  );
}

// ------------------------------------------------------------------ runsheet

function RunsheetTab({ projectId, people, nameOf }: { projectId: string; people: Person[]; nameOf: (id: string) => string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: runsheet, isLoading } = useQuery({
    queryKey: ["runsheet", projectId],
    queryFn: () => api.get<RunsheetDto>(`/projects/${projectId}/runsheet`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["runsheet", projectId] });

  const toggle = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) =>
      api.patch(`/runsheet-items/${itemId}/done`, { done }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  if (isLoading) return <div className="panel"><div className="empty">Loading runsheet…</div></div>;

  const hasRunsheet = !!runsheet?.id;

  return (
    <div>
      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!hasRunsheet && (
        <CreateRunsheetForm
          projectId={projectId}
          people={people}
          onDone={() => { setError(null); refresh(); }}
          onError={(e) => setError(e.message)}
        />
      )}

      {hasRunsheet && (
        <>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-title">Run of show</div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th style={{ width: 80 }}>Time</th>
                  <th>Cue</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {runsheet!.items.map((item) => (
                  <tr key={item.id} style={{ opacity: item.doneAt ? 0.55 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!item.doneAt}
                        onChange={(e) => toggle.mutate({ itemId: item.id, done: e.target.checked })}
                      />
                    </td>
                    <td className="mono small">{item.scheduledTime}</td>
                    <td style={{ textDecoration: item.doneAt ? "line-through" : "none" }}>{item.text}</td>
                    <td className="small">{nameOf(item.ownerId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <AddCueForm
            runsheetId={runsheet!.id!}
            people={people}
            onDone={() => { setError(null); refresh(); }}
            onError={(e) => setError(e.message)}
          />
        </>
      )}
    </div>
  );
}

interface DraftCue { scheduledTime: string; text: string; ownerId: string }

export function CreateRunsheetForm({
  projectId,
  people,
  onDone,
  onError,
}: {
  projectId: string;
  people: Person[];
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [lines, setLines] = useState<DraftCue[]>([{ scheduledTime: "", text: "", ownerId: "" }]);

  const create = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/runsheet`, {
        items: lines
          .filter((l) => l.scheduledTime && l.text.trim() && l.ownerId)
          .map((l) => ({ scheduledTime: l.scheduledTime, text: l.text.trim(), ownerId: l.ownerId })),
      }),
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  const valid = lines.some((l) => timePattern.test(l.scheduledTime) && l.text.trim() && l.ownerId);

  return (
    <div className="panel">
      <div className="panel-title">No runsheet yet — create one</div>
      <CueLinesEditor lines={lines} setLines={setLines} people={people} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
        <button className="btn-ghost btn-sm" onClick={() => setLines((prev) => [...prev, { scheduledTime: "", text: "", ownerId: "" }])}>
          + Add line
        </button>
        <button className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create runsheet"}
        </button>
      </div>
    </div>
  );
}

function CueLinesEditor({
  lines,
  setLines,
  people,
}: {
  lines: DraftCue[];
  setLines: React.Dispatch<React.SetStateAction<DraftCue[]>>;
  people: Person[];
}) {
  const patch = (i: number, p: Partial<DraftCue>) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...p } : l)));
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 100 }}>Time (HH:MM)</th>
          <th>Cue</th>
          <th style={{ width: 200 }}>Owner</th>
          <th style={{ width: 40 }} />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>
              <input className="inp mono" style={{ width: "100%" }} placeholder="18:00" value={l.scheduledTime} onChange={(e) => patch(i, { scheduledTime: e.target.value })} />
            </td>
            <td>
              <input className="inp" style={{ width: "100%" }} placeholder="Gates open" value={l.text} onChange={(e) => patch(i, { text: e.target.value })} />
            </td>
            <td>
              <select className="inp" style={{ width: "100%" }} value={l.ownerId} onChange={(e) => patch(i, { ownerId: e.target.value })}>
                <option value="">Select owner…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
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
  );
}

export function AddCueForm({
  runsheetId,
  people,
  onDone,
  onError,
}: {
  runsheetId: string;
  people: Person[];
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scheduledTime, setScheduledTime] = useState("");
  const [text, setText] = useState("");
  const [ownerId, setOwnerId] = useState("");

  const add = useMutation({
    mutationFn: () => api.post(`/runsheets/${runsheetId}/items`, { scheduledTime, text, ownerId }),
    onSuccess: () => { setScheduledTime(""); setText(""); setOwnerId(""); setOpen(false); onDone(); },
    onError: (e: ApiError) => onError(e),
  });

  if (!open) return <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>+ Add cue</button>;

  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime) && text.trim() && ownerId;

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-title">Add cue</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="small" style={{ color: "var(--text-dim)" }}>Time</span>
          <input className="inp mono" placeholder="18:00" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 200 }}>
          <span className="small" style={{ color: "var(--text-dim)" }}>Cue</span>
          <input className="inp" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 180 }}>
          <span className="small" style={{ color: "var(--text-dim)" }}>Owner</span>
          <select className="inp" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Select owner…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Adding…" : "Add"}
        </button>
        <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ checkins

function CheckinsTab({ projectId, people }: { projectId: string; people: Person[] }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState("");

  const { data: checkins, isLoading } = useQuery({
    queryKey: ["checkins", projectId],
    queryFn: () => api.get<CheckinDto[]>(`/projects/${projectId}/checkins`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["checkins", projectId] });

  const checkIn = useMutation({
    mutationFn: (userId?: string) => api.post(`/projects/${projectId}/checkins`, userId ? { userId } : {}),
    onSuccess: () => { setError(null); setTargetId(""); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  if (isLoading) return <div className="panel"><div className="empty">Loading check-ins…</div></div>;

  const checkedInIds = new Set((checkins ?? []).map((c) => c.userId));
  const selfCheckedIn = !!user && checkedInIds.has(user.id);
  const notCheckedIn = people.filter((p) => !checkedInIds.has(p.id));

  return (
    <div>
      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>
          {(checkins ?? []).length} of {people.length} checked in
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!selfCheckedIn && (
            <button className="btn-primary btn-sm" disabled={checkIn.isPending} onClick={() => checkIn.mutate(undefined)}>
              Check myself in
            </button>
          )}
          {notCheckedIn.length > 0 && (
            <>
              <select className="inp" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Check someone else in…</option>
                {notCheckedIn.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button className="btn-ghost btn-sm" disabled={!targetId || checkIn.isPending} onClick={() => checkIn.mutate(targetId)}>
                Check in
              </button>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Checked in</div>
        {(checkins ?? []).length === 0 && <div className="empty">Nobody has checked in yet.</div>}
        <table>
          <tbody>
            {(checkins ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.userName}</td>
                <td className="mono small tright">{fmtDate(c.checkedInAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- incidents

function IncidentsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("LOW");
  const [text, setText] = useState("");

  const { data: incidents, isLoading } = useQuery({
    queryKey: ["incidents", projectId],
    queryFn: () => api.get<IncidentDto[]>(`/projects/${projectId}/incidents`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["incidents", projectId] });

  const log = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/incidents`, { severity, text: text.trim() }),
    onSuccess: () => { setError(null); setText(""); setSeverity("LOW"); setOpen(false); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  if (isLoading) return <div className="panel"><div className="empty">Loading incidents…</div></div>;

  return (
    <div>
      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        {!open && <button className="btn-primary" onClick={() => setOpen(true)}>Log incident</button>}
        {open && (
          <div className="panel">
            <div className="panel-title">Log incident</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="small" style={{ color: "var(--text-dim)" }}>Severity</span>
                <select className="inp" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="CRITICAL">Critical</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 260 }}>
                <span className="small" style={{ color: "var(--text-dim)" }}>What happened</span>
                <input className="inp" value={text} onChange={(e) => setText(e.target.value)} />
              </label>
              <button className="btn-primary" disabled={!text.trim() || log.isPending} onClick={() => log.mutate()}>
                {log.isPending ? "Logging…" : "Log"}
              </button>
              <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
            {(severity === "HIGH" || severity === "CRITICAL") && (
              <div className="small" style={{ color: "var(--brass)", marginTop: 8 }}>
                {severity} incidents automatically raise a risk assigned to the project PM.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">Incident log</div>
        {(incidents ?? []).length === 0 && <div className="empty">No incidents logged.</div>}
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th>What happened</th>
              <th>Reported by</th>
              <th>Escalated</th>
              <th className="mono small">When</th>
            </tr>
          </thead>
          <tbody>
            {(incidents ?? []).map((i) => (
              <tr key={i.id}>
                <td><StatusPill status={i.severity} /></td>
                <td className="small">{i.text}</td>
                <td className="small">{i.reportedByName}</td>
                <td className="small">{i.raisedRiskId ? "Risk raised" : "—"}</td>
                <td className="mono small">{fmtDate(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
