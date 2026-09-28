"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { api, ApiError } from "../../lib/api";
import type { FlowTemplateOptionDto, PlaybookDto, PlaybookTaskDto } from "../../lib/types";

/**
 * Playbooks (Phase E, blueprint §19): reusable event-type templates applied
 * when a Won deal is converted into a project (LeadsService.convert()).
 * defaultStages is informational only (shown here, not wired to any
 * automated status transition); defaultTasks and defaultFlowTemplateIds are
 * the parts that actually create real rows on conversion.
 */
export default function PlaybooksPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PlaybookDto | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: playbooks, isLoading } = useQuery({
    queryKey: ["playbooks"],
    queryFn: () => api.get<PlaybookDto[]>("/playbooks"),
  });
  const { data: templates } = useQuery({
    queryKey: ["flow-templates"],
    queryFn: () => api.get<FlowTemplateOptionDto[]>("/flow-templates"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["playbooks"] });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/playbooks/${id}`),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  const templateName = (id: string) => templates?.find((t) => t.id === id)?.name ?? id;

  return (
    <AppShell crumb="Playbooks">
      <div className="page-head">
        <div>
          <div className="page-title">Playbooks</div>
          <div className="page-sub">Reusable event-type templates — applied automatically when a Won deal becomes a project.</div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setEditing("new")}>New playbook</button>
        </div>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {editing && (
        <PlaybookEditor
          playbook={editing === "new" ? null : editing}
          templates={templates ?? []}
          onDone={() => { setEditing(null); setError(null); refresh(); }}
          onCancel={() => setEditing(null)}
          onError={(e) => setError(e.message)}
        />
      )}

      <div className="panel">
        {isLoading && <div className="empty">Loading…</div>}
        {!isLoading && (playbooks?.length ?? 0) === 0 && <div className="empty">No playbooks yet.</div>}
        {(playbooks?.length ?? 0) > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Event type</th>
                <th>Stages</th>
                <th className="tright">Tasks</th>
                <th className="tright">Flows</th>
                <th className="mono small">Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {playbooks!.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="small">{p.eventType}</td>
                  <td className="small">{p.defaultStages.join(" → ") || "—"}</td>
                  <td className="tright mono">{p.defaultTasks.length}</td>
                  <td className="tright mono small">
                    {p.defaultFlowTemplateIds.length === 0 ? "—" : p.defaultFlowTemplateIds.map(templateName).join(", ")}
                  </td>
                  <td className="mono small">{fmtDate(p.createdAt)}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(p)}>Edit</button>
                    <button className="btn-warn btn-sm" onClick={() => remove.mutate(p.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

interface DraftTask { name: string; dueOffsetDays: string }

function PlaybookEditor({
  playbook,
  templates,
  onDone,
  onCancel,
  onError,
}: {
  playbook: PlaybookDto | null;
  templates: FlowTemplateOptionDto[];
  onDone: () => void;
  onCancel: () => void;
  onError: (e: ApiError) => void;
}) {
  const [name, setName] = useState(playbook?.name ?? "");
  const [eventType, setEventType] = useState(playbook?.eventType ?? "");
  const [stages, setStages] = useState(playbook?.defaultStages.join(", ") ?? "");
  const [tasks, setTasks] = useState<DraftTask[]>(
    playbook?.defaultTasks.length
      ? playbook.defaultTasks.map((t) => ({ name: t.name, dueOffsetDays: t.dueOffsetDays !== undefined ? String(t.dueOffsetDays) : "" }))
      : [{ name: "", dueOffsetDays: "" }],
  );
  const [templateIds, setTemplateIds] = useState<Set<string>>(new Set(playbook?.defaultFlowTemplateIds ?? []));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        eventType: eventType.trim(),
        defaultStages: stages.split(",").map((s) => s.trim()).filter(Boolean),
        defaultTasks: tasks
          .filter((t) => t.name.trim())
          .map((t): PlaybookTaskDto => ({
            name: t.name.trim(),
            ...(t.dueOffsetDays !== "" ? { dueOffsetDays: Number(t.dueOffsetDays) } : {}),
          })),
        defaultFlowTemplateIds: Array.from(templateIds),
      };
      return playbook ? api.patch(`/playbooks/${playbook.id}`, payload) : api.post("/playbooks", payload);
    },
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const patchTask = (i: number, p: Partial<DraftTask>) => setTasks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...p } : t)));
  const toggleTemplate = (id: string) =>
    setTemplateIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const valid = name.trim() && eventType.trim();

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">{playbook ? "Edit playbook" : "New playbook"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, marginBottom: 14 }}>
        <Field label="Name">
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Corporate Gala" />
        </Field>
        <Field label="Event type">
          <input className="inp" value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="Corporate" />
        </Field>
        <Field label="Stages (informational only, comma-separated)">
          <input className="inp" value={stages} onChange={(e) => setStages(e.target.value)} placeholder="Booking, Planning, Execution, Wrap-up" />
        </Field>
      </div>

      <div className="small" style={{ color: "var(--text-dim)", fontWeight: 500, marginBottom: 6 }}>
        Default tasks — created automatically on this playbook&apos;s project, owned by the converting PM
      </div>
      <table style={{ marginBottom: 10 }}>
        <thead>
          <tr>
            <th>Task</th>
            <th style={{ width: 200 }}>Due (days before event)</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t, i) => (
            <tr key={i}>
              <td>
                <input className="inp" style={{ width: "100%" }} value={t.name} onChange={(e) => patchTask(i, { name: e.target.value })} placeholder="Confirm venue" />
              </td>
              <td>
                <input className="inp tright" style={{ width: "100%" }} type="number" min="0" value={t.dueOffsetDays} onChange={(e) => patchTask(i, { dueOffsetDays: e.target.value })} placeholder="No due date" />
              </td>
              <td>
                {tasks.length > 1 && (
                  <button className="btn-ghost btn-sm" onClick={() => setTasks((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={() => setTasks((prev) => [...prev, { name: "", dueOffsetDays: "" }])}>
        + Add task
      </button>

      <div className="small" style={{ color: "var(--text-dim)", fontWeight: 500, marginBottom: 6 }}>
        Flow templates to instantiate on conversion
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
        {templates.length === 0 && <div className="small" style={{ color: "var(--text-faint)" }}>No flow templates in this workspace.</div>}
        {templates.map((t) => (
          <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <input type="checkbox" checked={templateIds.has(t.id)} onChange={() => toggleTemplate(t.id)} />
            {t.name} <span className="small" style={{ color: "var(--text-faint)" }}>({t.category})</span>
          </label>
        ))}
      </div>

      <div className="page-actions">
        <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save playbook"}
        </button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}
