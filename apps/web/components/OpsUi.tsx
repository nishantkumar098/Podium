"use client";

import { daysTo, fmtDate, initials } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { CityOptionDto } from "../lib/types";
import { FormField, Modal } from "./GovernanceUi";

// ------------------------------------------------------------------ types

export interface Person {
  id: string;
  name: string;
  dept?: string | null;
  role?: string | null;
}

export interface OpsTask {
  id: string;
  projectId: string;
  name: string;
  status: string;
  priority: string;
  dueAt: string | null;
  updatedAt: string;
  owner: { id: string; name: string };
  project?: { id: string; name: string };
}

export interface ProjectListItem {
  id: string;
  name: string;
  type: string;
  status: string;
  health: "GREEN" | "AMBER" | "RED";
  revenue: string | number;
  eventDate: string;
  eventDateText: string | null;
  city: { id: string; name: string };
  client: { id: string; name: string };
  pm: { id: string; name: string };
  team: Array<{ id: string; name: string }>;
  tasks: { done: number; total: number };
}

// ------------------------------------------------------------------ data hooks

/** Everyone who can own work — names only (GET /users/directory). */
export function useDirectory() {
  return useQuery({ queryKey: ["directory"], queryFn: () => api.get<Person[]>("/users/directory") });
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectListItem[]>("/projects") });
}

/** Projects whose event is today or later and still open — the working set for pickers. */
export function upcomingOnly(projects: ProjectListItem[] | undefined) {
  return (projects ?? []).filter((p) => daysTo(p.eventDate) >= 0 && p.status !== "COMPLETED" && p.status !== "CANCELLED");
}

// ------------------------------------------------------------------ labels

export const TASK_COLS = ["BACKLOG", "PLANNED", "IN_PROGRESS", "CLIENT_REVIEW", "APPROVED", "COMPLETED"] as const;

export function title(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const PILL: Record<string, string> = {
  CRITICAL: "red",
  HIGH: "amber",
  MEDIUM: "blue",
  LOW: "green",
  OPEN: "red",
  MITIGATING: "amber",
  MONITORING: "blue",
  CLOSED: "green",
  PLANNING: "gray",
  PLANNED: "blue",
  IN_PROGRESS: "amber",
  CLIENT_REVIEW: "blue",
  ON_HOLD: "gray",
  COMPLETED: "green",
  CANCELLED: "gray",
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
  BACKLOG: "gray",
};

/** Pill in the reference's Title Case ("In Progress", "Critical"). */
export function Pill({ value }: { value: string }) {
  return <span className={`pill ${PILL[value] ?? "gray"}`}>{title(value)}</span>;
}

export function HealthDot({ health }: { health: string }) {
  return <span className={`health-dot ${health}`} title={`Health: ${title(health)}`} />;
}

export function daysLabel(date: string): string {
  const d = daysTo(date);
  if (d === 0) return "today";
  return d > 0 ? `${d} days out` : `${-d} days ago`;
}

// ------------------------------------------------------------------ stages

/**
 * The master event staging from the reference design — the standard
 * countdown every event runs on. A project's current stage is derived purely
 * from its real event date.
 */
export const STAGES = ["T-180", "T-120", "T-90", "T-60", "T-30", "T-14", "T-7", "T-1", "EVENT DAY", "T+1", "T+7"] as const;

export function stageFor(eventDate: string): (typeof STAGES)[number] {
  const d = daysTo(eventDate);
  if (d > 150) return "T-180";
  if (d > 100) return "T-120";
  if (d > 70) return "T-90";
  if (d > 45) return "T-60";
  if (d > 20) return "T-30";
  if (d > 10) return "T-14";
  if (d > 3) return "T-7";
  if (d > 0) return "T-1";
  if (d === 0) return "EVENT DAY";
  return d >= -6 ? "T+1" : "T+7";
}

/** Horizontal stage strip. `current` highlights one stage; `counts` shows how many projects sit in each. */
export function StageStrip({ current, counts }: { current?: string; counts?: Record<string, number> }) {
  const at = current ? STAGES.indexOf(current as (typeof STAGES)[number]) : -1;
  return (
    <div className="stage-strip">
      {STAGES.map((s, i) => {
        const color = s === "EVENT DAY" ? "var(--red)" : at >= 0 && i < at ? "var(--green)" : i === at ? "var(--brass)" : counts ? "var(--brass)" : "var(--line)";
        return (
          <div className="st" key={s}>
            {i < STAGES.length - 1 && <div className="ln" />}
            <div className="d" style={{ background: color, outline: i === at ? "3px solid #F3E7C8" : undefined }} />
            <div className="lb">{s}</div>
            {counts && <div className="ct">{counts[s] ?? 0} project{counts[s] === 1 ? "" : "s"}</div>}
            {i === at && <div className="ct">you are here</div>}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ kanban

/**
 * Task board with drag-and-drop between status columns. The move is shown at
 * once and saved with the task's `updatedAt`, so a board that is out of date
 * (someone else moved the card) is refused by the server and reloaded rather
 * than silently overwriting their change.
 */
export function TaskKanban({ tasks, queryKeys, showProject }: { tasks: OpsTask[]; queryKeys: unknown[][]; showProject?: boolean }) {
  const qc = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: (t: { id: string; status: string; expectedUpdatedAt: string }) =>
      api.patch(`/tasks/${t.id}`, { status: t.status, expectedUpdatedAt: t.expectedUpdatedAt }),
    onSuccess: () => setError(null),
    onError: (e: ApiError) => setError(e.message),
    onSettled: async () => {
      await Promise.all([...queryKeys.map((k) => qc.invalidateQueries({ queryKey: k })), qc.invalidateQueries({ queryKey: ["projects"] })]);
      setMoved({});
    },
  });

  const statusOf = (t: OpsTask) => moved[t.id] ?? t.status;
  const drop = (col: string) => {
    setOver(null);
    const t = tasks.find((x) => x.id === dragId);
    setDragId(null);
    if (!t || statusOf(t) === col) return;
    setMoved((m) => ({ ...m, [t.id]: col }));
    move.mutate({ id: t.id, status: col, expectedUpdatedAt: t.updatedAt });
  };

  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="kanban">
        {TASK_COLS.map((col) => {
          const items = tasks.filter((t) => statusOf(t) === col);
          return (
            <div
              key={col}
              className={`kcol ${over === col ? "dragover" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(col);
              }}
              onDragLeave={() => setOver((o) => (o === col ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                drop(col);
              }}
            >
              <div className="kcol-head">
                <span>{title(col)}</span>
                <span className="n">{items.length}</span>
              </div>
              {items.map((t) => {
                const late = !!t.dueAt && daysTo(t.dueAt) < 0 && statusOf(t) !== "COMPLETED";
                return (
                  <div
                    key={t.id}
                    className={`kcard ${dragId === t.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                  >
                    <div className="t">{t.name}</div>
                    {showProject && t.project && (
                      <div style={{ fontSize: 10.3, color: "var(--text-dim)", marginBottom: 6 }}>{t.project.name}</div>
                    )}
                    <div className="foot">
                      <div className="who" title={t.owner.name}>
                        {initials(t.owner.name)}
                      </div>
                      {t.priority === "HIGH" || t.priority === "CRITICAL" ? <Pill value={t.priority} /> : null}
                      <span className={`due ${late ? "late" : ""}`}>{t.dueAt ? fmtDate(t.dueAt) : "No due date"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ modals

function useSave<T>(path: string, method: "post" | "patch", invalidate: unknown[][], onDone: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => (method === "post" ? api.post(path, body) : api.patch(path, body)),
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      onDone();
    },
  });
}

function ModalButtons({ onClose, onSave, saving, disabled, label }: { onClose: () => void; onSave: () => void; saving: boolean; disabled: boolean; label: string }) {
  return (
    <>
      <button className="btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button className="btn-primary" disabled={disabled || saving} onClick={onSave}>
        {saving ? "Saving…" : label}
      </button>
    </>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice red">{(error as Error).message}</div>;
}

export function PersonSelect({ value, onChange, people, placeholder = "Choose a person" }: { value: string; onChange: (id: string) => void; people: Person[] | undefined; placeholder?: string }) {
  return (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {people?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.role ? ` · ${p.role}` : ""}
        </option>
      ))}
    </select>
  );
}

export function ProjectSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data } = useProjects();
  const upcoming = upcomingOnly(data);
  const past = (data ?? []).filter((p) => !upcoming.includes(p));
  return (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a project</option>
      <optgroup label="Upcoming">
        {upcoming.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {fmtDate(p.eventDate)}
          </option>
        ))}
      </optgroup>
      <optgroup label="Past">
        {past
          .slice()
          .reverse()
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {fmtDate(p.eventDate)}
            </option>
          ))}
      </optgroup>
    </select>
  );
}

export function NewTaskModal({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const { data: people } = useDirectory();
  const [f, setF] = useState({ projectId: projectId ?? "", name: "", ownerId: "", dueAt: "", priority: "MEDIUM" });
  const save = useSave<unknown>("/tasks", "post", [["tasks"], ["project", f.projectId], ["projects"]], onClose);
  const ok = f.projectId && f.name.trim() && f.ownerId;
  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <ModalButtons
          onClose={onClose}
          saving={save.isPending}
          disabled={!ok}
          label="Add task"
          onSave={() => save.mutate({ projectId: f.projectId, name: f.name.trim(), ownerId: f.ownerId, priority: f.priority, ...(f.dueAt ? { dueAt: f.dueAt } : {}) })}
        />
      }
    >
      {!projectId && (
        <FormField label="Project">
          <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} />
        </FormField>
      )}
      <FormField label="Task">
        <input className="inp" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Confirm bar layout with venue" />
      </FormField>
      <FormField label="Owner">
        <PersonSelect value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} people={people} />
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Due">
          <input className="inp" type="date" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
        </FormField>
        <FormField label="Priority">
          <select className="inp" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
              <option key={p} value={p}>
                {title(p)}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <ErrorLine error={save.error} />
    </Modal>
  );
}

export function NewRiskModal({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const { data: people } = useDirectory();
  const [f, setF] = useState({ projectId: projectId ?? "", title: "", severity: "MEDIUM", ownerId: "", impact: "" });
  const save = useSave<unknown>("/risks", "post", [["risks"], ["project", f.projectId], ["projects"]], onClose);
  const ok = f.projectId && f.title.trim() && f.ownerId;
  return (
    <Modal
      title="New risk"
      onClose={onClose}
      footer={
        <ModalButtons
          onClose={onClose}
          saving={save.isPending}
          disabled={!ok}
          label="Raise risk"
          onSave={() => save.mutate({ projectId: f.projectId, title: f.title.trim(), severity: f.severity, ownerId: f.ownerId, ...(f.impact.trim() ? { impact: f.impact.trim() } : {}) })}
        />
      }
    >
      {!projectId && (
        <FormField label="Project">
          <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} />
        </FormField>
      )}
      <FormField label="Risk">
        <input className="inp" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What could go wrong?" />
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Severity">
          <select className="inp" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
              <option key={p} value={p}>
                {title(p)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Owner">
          <PersonSelect value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} people={people} />
        </FormField>
      </div>
      <FormField label="Impact (optional)">
        <input className="inp" value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} placeholder="e.g. Bar opens late; guest experience" />
      </FormField>
      <div className="small muted">A Critical risk turns the project&apos;s health red until it is mitigated or closed.</div>
      <ErrorLine error={save.error} />
    </Modal>
  );
}

/** + New Project. Client is searched live (GET /clients?search=), so any of the imported clients can be chosen. */
export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: people } = useDirectory();
  const { data: cities } = useQuery({ queryKey: ["cities"], queryFn: () => api.get<CityOptionDto[]>("/cities") });
  const [q, setQ] = useState("");
  const { data: clients } = useQuery({
    queryKey: ["client-search", q],
    queryFn: () => api.get<{ rows: Array<{ id: string; name: string; city: { name: string } | null }> }>(`/clients?search=${encodeURIComponent(q)}&limit=15`),
    enabled: q.trim().length >= 2,
  });
  const [f, setF] = useState({ name: "", clientId: "", clientName: "", type: "", cityId: "", eventDate: "", pmId: "", revenue: "", estCost: "" });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/projects", {
        name: f.name.trim(),
        clientId: f.clientId,
        type: f.type.trim(),
        cityId: f.cityId,
        eventDate: f.eventDate,
        pmId: f.pmId,
        revenue: Number(f.revenue || 0),
        estCost: Number(f.estCost || 0),
      }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(p.id);
    },
  });
  const ok = f.name.trim() && f.clientId && f.type.trim() && f.cityId && f.eventDate && f.pmId;
  return (
    <Modal title="New project" onClose={onClose} footer={<ModalButtons onClose={onClose} saving={save.isPending} disabled={!ok} label="Create project" onSave={() => save.mutate()} />}>
      <FormField label="Project name">
        <input className="inp" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sharma — Taj Lake Palace" />
      </FormField>
      <FormField label="Client">
        {f.clientId ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{f.clientName}</b>
            <button className="btn-ghost btn-sm" onClick={() => setF({ ...f, clientId: "", clientName: "" })}>
              Change
            </button>
          </div>
        ) : (
          <>
            <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type 2+ letters to search clients" />
            {clients?.rows.map((c) => (
              <button key={c.id} className="btn-ghost btn-sm" style={{ textAlign: "left" }} onClick={() => setF({ ...f, clientId: c.id, clientName: c.name })}>
                {c.name}
                {c.city ? ` · ${c.city.name}` : ""}
              </button>
            ))}
            {q.trim().length >= 2 && clients?.rows.length === 0 && <span className="small muted">No client by that name — add them under Clients first.</span>}
          </>
        )}
      </FormField>
      <div className="grid g2" style={{ gap: 10 }}>
        <FormField label="Event type">
          <input className="inp" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} placeholder="Wedding, Corporate…" />
        </FormField>
        <FormField label="City">
          <select className="inp" value={f.cityId} onChange={(e) => setF({ ...f, cityId: e.target.value })}>
            <option value="">Choose a city</option>
            {cities?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Event date">
          <input className="inp" type="date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />
        </FormField>
        <FormField label="Project manager">
          <PersonSelect value={f.pmId} onChange={(v) => setF({ ...f, pmId: v })} people={people} />
        </FormField>
        <FormField label="Revenue (₹)">
          <input className="inp" type="number" min={0} value={f.revenue} onChange={(e) => setF({ ...f, revenue: e.target.value })} />
        </FormField>
        <FormField label="Estimated cost (₹)">
          <input className="inp" type="number" min={0} value={f.estCost} onChange={(e) => setF({ ...f, estCost: e.target.value })} />
        </FormField>
      </div>
      <ErrorLine error={save.error} />
    </Modal>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
